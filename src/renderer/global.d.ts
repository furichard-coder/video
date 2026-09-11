import type { AppApi } from "../shared/domain";

declare global {
  interface Window {
    sourceApp: AppApi;
  }
}

export {};
