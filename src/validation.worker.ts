import type { LeagueProfile } from "./league-profiles";
import type { StoredFixture, SyncSnapshotMeta } from "./storage";
import { runFormalValidation, type ValidationProgress, type ValidationReport } from "./validation";

export type ValidationWorkerRequest = {
  profile: LeagueProfile;
  fixtures: StoredFixture[];
  snapshots: SyncSnapshotMeta[];
};

export type ValidationWorkerResponse =
  | { type: "progress"; progress: ValidationProgress }
  | { type: "report"; report: ValidationReport }
  | { type: "error"; message: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<ValidationWorkerRequest>) => void) | null;
  postMessage(message: ValidationWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = async (event) => {
  try {
    const report = await runFormalValidation(event.data, {
      yieldEvery: 5,
      onProgress: (progress) => workerScope.postMessage({ type: "progress", progress }),
    });
    workerScope.postMessage({ type: "report", report });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "正式版验证失败",
    });
  }
};
