/** Deterministic, fictional screening cases for offline regression and local benchmarks.
 * Gold labels are generated, not independently human-annotated; this is NOT the G2 quality set.
 */
export interface SyntheticScreeningCase {
  id: string;
  text: string;
  expected: "include" | "skip" | "review";
  category?: "grudge" | "rights" | "danger";
  media?: "image" | "audio" | "video";
}

const related = [
  ["公司承诺的加班费仍未结清，工资单与打卡记录金额不一致。", "rights"],
  ["网购商品损坏，商家确认退款后又拒绝履行。", "rights"],
  ["房东未经同意进入房间，我保留了门锁记录。", "rights"],
  ["同事当众辱骂我，并在群里重复了这些话。", "grudge"],
  ["约好的借款归还日期已过，对方再次失联。", "rights"],
  ["邻居在楼道堵住我并发出威胁，我录下了声音。", "danger"],
  ["有人连续数日跟到我家门口，我拍下了车辆。", "danger"],
  ["施工现场护栏倒塌险些砸到我，我拍下了现场。", "danger"],
  ["客服泄露了我的收货地址，随后接到骚扰电话。", "rights"],
  ["合作方收了定金却不交付，也拒绝出示合同变更。", "rights"]
] as const;
const ordinary = [
  "午饭后散步，下午工作顺利。", "今天坐地铁上班，路上看了一本书。",
  "给家里的植物浇水，晚上做了晚饭。", "周末和朋友去公园拍照。",
  "整理书桌并备份了电脑文件。", "电影里有人受到威胁，剧情很紧张。",
  "新闻说某地发生消费纠纷，我只是读了报道。", "昨天没有发生争执，一切正常。",
  "梦见有人跟踪我，醒来后发现只是梦。", "写小说时构思了一个退款争议的桥段。"
];
const ambiguous = [
  "他又这样说了，我有些不安，但还没想好怎么描述。",
  "这笔钱似乎不对，等我拿到账单再确认。",
  "有人在门口等了一会儿，不确定是否和我有关。",
  "今天那件事让我难受，稍后再补充经过。",
  "收到一条语气奇怪的信息，暂时不知道是谁发的。"
];

export const syntheticScreeningCases: SyntheticScreeningCase[] = [
  ...Array.from({ length: 80 }, (_, index): SyntheticScreeningCase => {
    const [text, category] = related[index % related.length]!;
    return {
      id: `related-${String(index + 1).padStart(3, "0")}`,
      text: `${text}（合成样本 ${index + 1}，事件发生于第 ${Math.floor(index / 10) + 1} 周。）`,
      expected: "include", category,
      ...(index < 30 ? { media: (["image", "audio", "video"] as const)[index % 3] } : {})
    };
  }),
  ...Array.from({ length: 80 }, (_, index): SyntheticScreeningCase => ({
    id: `ordinary-${String(index + 1).padStart(3, "0")}`,
    text: `${ordinary[index % ordinary.length]!}（合成样本 ${index + 1}。）`,
    expected: "skip",
    ...(index < 20 ? { media: (["image", "audio", "video"] as const)[index % 3] } : {})
  })),
  ...Array.from({ length: 40 }, (_, index): SyntheticScreeningCase => ({
    id: `review-${String(index + 1).padStart(3, "0")}`,
    text: `${ambiguous[index % ambiguous.length]!}（合成样本 ${index + 1}。）`,
    expected: "review",
    ...(index < 10 ? { media: (["image", "audio", "video"] as const)[index % 3] } : {})
  }))
];
