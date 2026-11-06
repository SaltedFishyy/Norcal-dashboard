// Verified header text only; all test prices below are synthetic.
export const sfoHeader = [
  [
    "DSP报价/Quotation for DSP"
  ],
  [
    "站点名称/Station",
    "转运中心/Sorting Center",
    "线路名称/Route",
    "邮编/Zipcode",
    "参考邮编",
    "按重量段报价（美元/单）/Quotation by weight range (USD/Parcel)",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "备注/Remarks"
  ],
  [
    null,
    "\n",
    null,
    null,
    null,
    "首票价格\n0 - 1(lb)/Quotation for the First Parcel 0 - 1(lb)",
    "首票价格\n1-5(lb)/Quotation for the First Parcel 1-5(lb)",
    "首票价格\n5-10(lb)/Quotation for the First Parcel 5-10(lb)",
    "首票价格\n10-20(lb)/Quotation for the First Parcel 10-20(lb)",
    "首票价格\n20-30(lb)/Quotation for the First Parcel 20-30(lb)",
    "首票价格\n30-40(lb)/Quotation for the First Parcel 30-40(lb)",
    "首票价格\n40(Ib)以上//Quotation for the First Parcel Above 40(lb)",
    "续票价格\n0 - 1(lb)/Quotation for second and subsequent pieces of the same stop 0 - 1(lb)",
    "续票价格\n1-5(lb)/Quotation for second and subsequent pieces of the same stop 1-5(lb)",
    "续票价格\n5-10(lb)/Quotation for second and subsequent pieces of the same stop 5-10(lb)",
    "续票价格\n10-20(lb)/Quotation for second and subsequent pieces of the same stop 10-20(lb)",
    "续票价格\n20-30(lb)/Quotation for second and subsequent pieces of the same stop 20-30(lb)",
    "续票价格\n30-40(lb)/Quotation for second and subsequent pieces of the same stop 30-40(lb)",
    "40(Ib)以上)/Quotation for second and subsequent pieces of the same stop Above 40(lb)",
    "报价生效日期/Quotation Effective Date",
    "报价结束日期/Quotation End Date",
    "是否使用第二票半价"
  ]
];
export const summaryHeader = [
  [
    "s'f"
  ],
  [
    "站点名称/Station",
    "转运中心/Sorting Center",
    "线路名称/Route",
    "邮编/Zipcode",
    "参考邮编/Zipcode",
    "按重量段报价（美元/单）/Quotation by weight range (USD/Parcel)"
  ],
  [
    null,
    null,
    null,
    null,
    null,
    "0 - 1(Ib)",
    "1-5(Ib)",
    "5-10(Ib)",
    "10-20(lb)",
    "20-30(lb)",
    "30-40(lb)",
    "40(Ib)以上/Above 40(lb)"
  ]
];
export function syntheticCells() {
  return [' Mock Station ', ' Mock Fleet ', ' Mock Route ', 12345, 'ref',
    ...Array.from({length:14}, (_, i) => 900 + i), '11/1/2026', null, '是', ' Mock remarks '];
}
