import { createReadStream, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from '../../http/http-error.ts';

/**
 * Filename sanitisation for the desktop-installer download endpoint.
 *
 * Allowlist of extensions keeps the route scoped to release artifacts
 * (installers + auto-update manifests) so it cannot be abused as a generic
 * file server. The basename regex prevents path traversal and odd characters.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.dmg',
  '.zip',
  '.exe',
  '.blockmap',
  '.yml',
]);

const ALLOWED_BASENAME = /^[A-Za-z0-9._-]+$/u;

const MAX_FILENAME_LENGTH = 128;

/** Content-Type per release artifact extension. */
const CONTENT_TYPES: Record<string, string> = {
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8',
};

export interface DownloadRouteDependencies {
  /**
   * Absolute path to the directory holding release artifacts. Files outside
   * this directory are unreachable regardless of the requested filename.
   */
  readonly root: string;
}

function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  for (const ext of ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext))
      return CONTENT_TYPES[ext] ?? 'application/octet-stream';
  }
  return 'application/octet-stream';
}

/**
 * Resolve the requested filename against the downloads root and reject any
 * attempt to escape the root. We use the same approach as the static-file
 * plugin: normalise and confirm the resolved path still starts with root.
 */
function resolveDownloadPath(root: string, filename: string): string {
  if (filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) {
    throw new HttpError(404, 'INVALID_STATE', 'File not found');
  }
  if (filename.includes('/') || filename.includes('\\')) {
    throw new HttpError(404, 'INVALID_STATE', 'File not found');
  }
  if (!ALLOWED_BASENAME.test(filename)) {
    throw new HttpError(404, 'INVALID_STATE', 'File not found');
  }
  const lower = filename.toLowerCase();
  const allowed = [...ALLOWED_EXTENSIONS].some((ext) => lower.endsWith(ext));
  if (!allowed) {
    throw new HttpError(404, 'INVALID_STATE', 'File not found');
  }
  const resolved = resolve(root, filename);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    // Should be unreachable given the checks above, but guard anyway.
    throw new HttpError(404, 'INVALID_STATE', 'File not found');
  }
  return resolved;
}

export function registerDownloadRoutes(
  app: FastifyInstance,
  dependencies: DownloadRouteDependencies,
): void {
  app.get(
    '/download/:filename',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { filename } = request.params as { readonly filename: string };
      const filePath = resolveDownloadPath(dependencies.root, filename);
      let size: number;
      try {
        const stats = statSync(filePath);
        if (!stats.isFile()) {
          throw new HttpError(404, 'INVALID_STATE', 'File not found');
        }
        size = stats.size;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(404, 'INVALID_STATE', 'File not found');
      }
      void reply.type(contentTypeFor(filename));
      void reply.header('Content-Length', String(size));
      void reply.header(
        'Content-Disposition',
        `attachment; filename="${filename.replace(/["\\]/gu, '_')}"`,
      );
      void reply.header('Cache-Control', 'public, max-age=3600');
      return reply.send(createReadStream(filePath));
    },
  );
}
