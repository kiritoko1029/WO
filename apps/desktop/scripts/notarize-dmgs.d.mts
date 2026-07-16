export interface DmgArtifact {
  readonly path: string;
  readonly architecture: 'x64' | 'arm64';
}

export type DmgNotarizeCredentials =
  | Readonly<{
      keychainProfile: string;
      keychain?: string;
    }>
  | Readonly<{
      appleApiKey: string;
      appleApiKeyId: string;
      appleApiIssuer: string;
    }>
  | Readonly<{
      appleId: string;
      appleIdPassword: string;
      teamId: string;
    }>;

export type DmgNotarizeOptions = DmgNotarizeCredentials &
  Readonly<{ appPath: string }>;

export function notarizationCredentials(
  environment?: Readonly<Record<string, string | undefined>>,
): DmgNotarizeCredentials;

export function notarizeDmgArtifacts(
  options: Readonly<{ packageDirectory: string }>,
  dependencies?: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    notarizeArtifact?: (options: DmgNotarizeOptions) => Promise<void>;
  }>,
): Promise<readonly DmgArtifact[]>;
