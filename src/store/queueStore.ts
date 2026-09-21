import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type CropMode = "pad" | "crop";

export interface QueueJob {
  id: string;
  inputPath: string;
  outputPath: string;
  inputBasename: string;
  duration: number;
  fileSize: number;
  resolution: string;
  videoWidth: number;
  videoHeight: number;
  sourceBitrate: number;
  videoCodec: string;
  hasVideo: boolean;
  thumbnailPath?: string;
  status: JobStatus;
  presetId: string;
  startRequested: boolean;
  progress: number;
  speed: string;
  fps: string;
  bitrate: string;
  etaSeconds: number | null;
  error?: string;
  addedAt: number;
  finishedAt?: number;
  bitratePercent: number;
  targetResolution: string;
  cropMode: CropMode;
}

interface QueueState {
  jobs: QueueJob[];
  runningJobId: string | null;
  addJobs: (jobs: QueueJob[]) => void;
  updateJob: (id: string, patch: Partial<QueueJob>) => void;
  removeJob: (id: string) => void;
  clearCompleted: () => void;
  clearAll: () => void;
  setRunningJobId: (id: string | null) => void;
  setStartRequested: (ids: string[], value: boolean) => void;
}

export const useQueueStore = create<QueueState>()(
  persist(
    (set) => ({
      jobs: [],
      runningJobId: null,
      addJobs: (newJobs) => set((s) => ({ jobs: [...s.jobs, ...newJobs] })),
      updateJob: (id, patch) =>
        set((s) => ({
          jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
        })),
      removeJob: (id) =>
        set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
      clearCompleted: () =>
        set((s) => ({
          jobs: s.jobs.filter(
            (j) => j.status === "queued" || j.status === "running"
          ),
        })),
      clearAll: () => set({ jobs: [], runningJobId: null }),
      setRunningJobId: (id) => set({ runningJobId: id }),
      setStartRequested: (ids, value) =>
        set((s) => ({
          jobs: s.jobs.map((j) =>
            ids.includes(j.id) ? { ...j, startRequested: value } : j
          ),
        })),
    }),
    {
      name: "vidflux:queue",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ jobs: state.jobs }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.jobs = state.jobs.map((j) => {
          if (j.status === "running") {
            return {
              ...j,
              status: "queued",
              progress: 0,
              speed: "",
              fps: "",
              bitrate: "",
              etaSeconds: null,
              startRequested: false,
              error: undefined,
            };
          }
          if (j.status === "queued" && j.startRequested) {
            return { ...j, startRequested: false };
          }
          return j;
        });
        state.runningJobId = null;
      },
    }
  )
);