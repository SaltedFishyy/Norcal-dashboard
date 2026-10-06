import { difficultyLevel } from './difficulty.js';
import { formatUpdated } from './format.js';

export const mapText = {
  byRoute: '按线路', byDifficulty: '按难易度', colorMode: '地图颜色模式',
  routeDifficulty: '线路难度', zipDifficulty: 'ZIP 难度',
  legendRoute: '颜色：线路难度', legendZip: name => `颜色：${name} 的 ZIP 难度`,
  legendItems: ['S 极难', 'A 难', 'B 中', 'C 易', 'D 极易', '无数据'],
  missingDetail: '暂无 ZIP 难度数据',
  detailCommand: station => `npm run dms:scrape-route-details -- --station ${station}`,
  detailAvailable: (count, time) => `ZIP 难度：已有 ${count} 个 ZIP · 更新于 ${formatUpdated(time)}`,
  invalidDetail: '线路详情文件无效，ZIP 难度不可用',
  noZipDifficulty: '—（DMS 无数据）',
  zipNotInDetail: time => `—（该 ZIP 不在线路详情中，详情更新于 ${formatUpdated(time)}）`,
  title: '线路地图', station: '站点', route: '线路', zip: '邮编', current: '当前选择',
  profiles: '线路档案', snapshot: 'DMS 快照，非实时数据', updated: '更新时间',
  search: '搜索线路或邮编', zipHint: '输入完整 5 位邮编可搜索邮编', noMatch: '未找到匹配线路',
  fit: '定位站点', clear: '清除选择', summary: '线路概览', currentZip: '当前邮编',
  zoomIn: '放大', zoomOut: '缩小',
  coverage: '地图覆盖率', missing: '缺少边界的邮编', reason: '原因', retry: '重试',
  zipCount: 'ZIP 数', mapped: count => `已上图 ${count}`,
  missingTitle: count => `缺少边界的邮编 (${count})`,
  coverageCount: (mapped, total) => `${mapped} / ${total} ZIP 已上图`,
  missingCount: (absent, unchecked) => `${absent} 无 Census ZCTA · ${unchecked} 需重新生成边界`,
  noZcta: '无 Census ZCTA', notChecked: '边界数据未覆盖（需重新生成）',
  boundaries: (dataset, vintage) => `边界来源：${dataset} (${vintage})`,
  noMissing: '没有缺少边界的邮编。', noMapped: '该线路暂无已上图边界',
  summaryHint: '选择线路或邮编以查看线路概览。', source: 'Source: DMS snapshot',
  loadingStations: '正在加载站点…', loadingStation: station => `正在加载 ${station} 线路地图…`,
  loaded: station => `${station} 线路地图已加载。`, noRoutes: '暂无数据：该站点没有线路邮编。',
  noBoundaries: '暂无已上图边界，请查看缺少边界的邮编清单。', noStations: '暂无数据：没有站点快照。',
  noData: (station, code) => `${station || '所有站点'} 暂无数据 (${code})。`,
  loadError: (code, station) => `无法加载线路地图 (${code})。${code === 'postal_codes_missing' ? ` 请运行 npm run dms:scrape -- --station ${station}。` : ''}`,
  networkError: '无法从本地服务器加载线路地图 (network_error)。',
  stationsError: '无法从本地服务器加载站点 (network_error)。',
  zipLoading: zip => `正在搜索邮编 ${zip}…`, zipError: code => `邮编搜索失败 (${code})。`,
  basemapError: '底图尚未安装或暂不可用，请参阅 docs/features/route-map.md（RM2 底图生成）。',
  mapLabel: '线路邮编覆盖地图',
  boundaryNote: 'ZCTA 是 USPS ZIP 区域的近似边界，不能用于具体地址的线路分配。',
  noscript: '请启用 JavaScript 以加载本地线路地图。',
  statuses: {
    covered: '有线路覆盖', covered_no_boundary: '有线路覆盖', uncovered: '当前无线路覆盖',
    no_boundary: '暂无可用边界数据', out_of_range: '不在支持范围内',
  },
  zipNotes: {
    covered: '该 ZIP 有线路覆盖，地图已定位并高亮。',
    covered_no_boundary: '有线路覆盖 · 该 ZIP 暂无可用边界数据',
    uncovered: '该 ZIP 当前无线路覆盖，地图以虚线高亮。',
    no_boundary: '该 ZIP 暂无可用边界数据（可能是 PO Box / 机构 ZIP，或不是有效 ZIP）',
    out_of_range: '该 ZIP 不在当前支持的地图范围内（CA / NV / OR）',
  },
};

export function localizeMap(doc) {
  for (const node of doc.querySelectorAll('[data-map-text]')) node.textContent = mapText[node.dataset.mapText];
  doc.title = `${mapText.title} — NC Ops Console`;
  doc.getElementById('map-search').placeholder = mapText.search;
  doc.getElementById('route-map').setAttribute('aria-label', mapText.mapLabel);
  doc.getElementById('map-station').setAttribute('aria-label', mapText.station);
  doc.getElementById('map-routes').setAttribute('aria-label', mapText.route);
}

export const routeDifficultyText = value => difficultyLevel(value) ? value : '—';
export function zipDifficultyText(properties, detail) {
  if (properties.zip_detail_status === 'missing' || !properties.zip_detail_status) return mapText.missingDetail;
  if (properties.zip_detail_status === 'not_in_detail') return mapText.zipNotInDetail(detail?.fetched_at);
  return difficultyLevel(properties.zip_difficulty) ? properties.zip_difficulty : mapText.noZipDifficulty;
}
