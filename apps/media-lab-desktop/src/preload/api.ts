export interface CaptureSourceSummary {
  readonly id: string;
  readonly name: string;
  readonly thumbnailDataUrl: string;
}

export interface MediaLabApi {
  listSources(): Promise<readonly CaptureSourceSummary[]>;
  selectSource(id: string): Promise<void>;
  exportStats(json: string): Promise<string | null>;
}

export type Invoke = (
  channel: string,
  ...arguments_: readonly unknown[]
) => Promise<unknown>;

export function createMediaLabApi(invoke: Invoke): Readonly<MediaLabApi> {
  return Object.freeze({
    listSources: () =>
      invoke('media-lab:list-sources') as Promise<
        readonly CaptureSourceSummary[]
      >,
    selectSource: async (id: string) => {
      await invoke('media-lab:select-source', id);
    },
    exportStats: (json: string) =>
      invoke('media-lab:export-stats', json) as Promise<string | null>,
  });
}
