import { difficultyLevel } from './difficulty.js';
import { formatUpdated } from './format.js';

export const mapText = {
  firstPrice: '首票价格', priceDetail: '价格详情',
  retainedZip: zip => `已保留 ZIP ${zip}，按 Enter 在当前范围重新查询`,
  allDsp: '全部 DSP',
  byRoute: '按线路', byDifficulty: '按难易度', colorMode: '地图颜色模式',
  routeDifficulty: '线路难度', zipDifficulty: 'ZIP 难度',
  legendRoute: '颜色：线路难度', legendZip: name => `颜色：${name} 的 ZIP 难度`,
  legendItems: ['S 极难', 'A 难', 'B 中', 'C 易', 'D 极易', '无数据'],
  missingDetail: '暂无 ZIP 难度数据',
  detailAvailable: (count, time) => `ZIP 难度：已有 ${count} 个 ZIP · 更新于 ${formatUpdated(time)}`,
  invalidDetail: '线路详情文件无效，ZIP 难度不可用',
  title: '线路地图', station: '站点', route: '线路', zip: '邮编', zipLabel: 'ZIP', dsp: 'DSP', experiencedPph: '熟手 PPH', pickupDaily: '领件量（日均）', pickupVolume: 'Pickup Volume', pph: 'PPH',
  profiles: '线路档案', snapshot: 'DMS 快照，非实时数据', updated: '数据更新时间',
  search: '搜索线路编号或邮编', zipHint: '输入完整 5 位邮编可搜索邮编', noMatch: '未找到匹配线路',
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
  crossStation: '以下 ZIP 同时出现在多个站点：',
  statuses: {
    multi_station: '多个站点',
    covered: '有线路覆盖', covered_no_boundary: '有线路覆盖', uncovered: '当前无线路覆盖',
    no_boundary: '暂无可用边界数据', out_of_range: '不在支持范围内',
  },
  zipNotes: { out_of_range: '支持范围：CA / NV / OR' },
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

export const warehouseText = {
  manage: '管理仓库', legend: '仓库', markerTitle: name => `仓库：${name}`,
  name: 'Name', address: 'Address', district: 'District', station: 'Station',
  close: '关闭', current: '当前片区', all: '全部仓库', add: '添加仓库', edit: '编辑', delete: '删除',
  save: '保存', cancel: '取消', unspecified: '不指定', chooseDistrict: '请选择片区',
  readonly: '当前服务未开启仓库编辑', empty: '暂无仓库', loading: '正在加载仓库…',
  loadError: '仓库信息暂时无法加载', saveError: '保存失败，请稍后重试',
  unknownDistrict: '片区不存在 / Unknown District', unknownStation: '站点不存在',
  manual: '手动输入坐标', latitude: '纬度', longitude: '经度',
  duplicate: '可能重复：', far: km => `位置距离所选片区约 ${km} km，请确认地址是否正确`,
  matched: address => `识别地址：${address}`, located: address => `已定位：${address}`,
  confirmSave: '确认保存', back: '返回修改', duplicateName: '已有同名仓库',
  savedTo: district => `已保存到 ${district}`, view: '查看仓库',
  deleteConfirm: (name, address) => `确定删除 ${name}？\n${address}`,
  invalid: fields => `请检查字段：${fields.join('、')}`,
  errors: {
    geocode_failed: '地址无法识别', geocode_ambiguous: '地址无法识别',
    geocode_unavailable: '定位服务暂时不可用', station_not_in_district: '站点不属于所选片区',
    district_not_found: '片区不存在，请重新选择',
    warehouse_changed: '仓库已被其他人修改，请重新加载后再编辑', warehouse_not_found: '仓库已不存在',
  },
};
