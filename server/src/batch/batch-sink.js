import * as fs from 'node:fs/promises';

// Keep the guard at the atomic rename boundary, ready for a future COMMIT hook.
export function createJsonBatchSink({ runtimeDir, saveDetail, saveSnapshot, writeBatch }) {
  const commitFileOps = beforeCommit => ({ ...fs, rename: async (...params) => {
    await beforeCommit();
    return fs.rename(...params);
  } });
  const writeState = state => writeBatch({ runtimeDir, state });
  return {
    startRun: writeState,
    writeState,
    writeStationSummary: ({ state, station, record }) => writeBatch({ runtimeDir, state, station, record }),
    writeRouteDetail: ({ route, beforeCommit }) => saveDetail({ runtimeDir, route, fileOps: commitFileOps(beforeCommit) }),
    activateStationSnapshot: ({ station, stationSnapshot, beforeCommit }) =>
      saveSnapshot({ runtimeDir, station, stationSnapshot, fileOps: commitFileOps(beforeCommit) }),
    async finishRun({ state, record }) {
      await writeState(state);
      return writeBatch({ runtimeDir, state, record });
    },
  };
}
