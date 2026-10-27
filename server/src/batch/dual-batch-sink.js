export class DbStoreError extends Error {
  constructor(cause) { super('数据库写入失败，批次已停止。', { cause }); this.name = 'DbStoreError'; }
}

export function createDualBatchSink(jsonSink, dbSink) {
  return Object.fromEntries(['startRun', 'writeState', 'writeStationSummary', 'writeRouteDetail', 'activateStationSnapshot', 'finishRun']
    .map(action => [action, async (...args) => {
      const result = await jsonSink[action](...args);
      try { await dbSink[action](...args); } catch (error) { throw new DbStoreError(error); }
      return result;
    }]));
}
