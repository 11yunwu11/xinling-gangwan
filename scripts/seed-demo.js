// 写入几篇示例日记（供 demo 展示 RAG 记忆效果），向量留空、服务启动时自动回填。
// 运行：npm run seed   （已有日记时不会重复写入）

const store = require('../server/lib/store');
const time = require('../server/lib/time');
const config = require('../server/lib/config');

const SAMPLES = [
  {
    dateKey: null, // 用 createdAt 推近几天
    text: '今天考试考砸了，走出教室的时候整个人都是懵的。明明复习了很久，但坐下来看到卷子还是大脑一片空白。回到宿舍躺在床上刷了两个小时手机，越刷越空虚。晚上室友拉我去操场走了两圈，走着走着好像好受了一点，风吹着挺舒服的。',
    summary: {
      emotions: ['低落', '空虚', '些许放松'],
      keyEvents: ['考试考砸了', '刷手机两小时', '和室友散步'],
      theme: '考试',
    },
    daysAgo: 5,
  },
  {
    dateKey: null,
    text: '最近总是睡前想很多，一躺下就开始回放白天说过的每一句话，觉得自己这里说错了那里不该说。今晚上网课的时候老师表扬了我的作业，其实心里挺高兴的，但转头又开始担心下次是不是就没这么好运了。凌晨一点才睡着。',
    summary: {
      emotions: ['焦虑', '自我怀疑', '片刻高兴'],
      keyEvents: ['睡前反刍', '作业被老师表扬'],
      theme: '自我怀疑',
    },
    daysAgo: 3,
  },
  {
    dateKey: null,
    text: '今天按照之前和树洞的约定，早上出门前开窗站了一分钟。天空是灰的但没有下雨，风是凉的。下午去食堂吃了很久没吃的糖醋排骨，吃到第一口的时候突然觉得，好像也没有那么糟。晚上早点睡了。',
    summary: {
      emotions: ['平静', '少许开心'],
      keyEvents: ['开窗一分钟', '吃到糖醋排骨', '早睡'],
      theme: '小行动',
    },
    daysAgo: 1,
  },
];

if (store.listDiaries().length) {
  console.log('已有日记，跳过种子写入。');
  process.exit(0);
}

for (const s of SAMPLES) {
  const createdAt = new Date(Date.now() - s.daysAgo * 24 * 3600 * 1000).toISOString();
  const dateKey = time.currentLogicalKey(config.get().wakeTime, new Date(createdAt));
  store.addDiary({ dateKey, text: s.text, summary: s.summary, embedding: null });
  const diaries = store.listDiaries();
  diaries[diaries.length - 1].createdAt = createdAt;
  store.setDiaries(diaries);
}
console.log(`已写入 ${SAMPLES.length} 篇示例日记（向量将在下次启动服务时自动回填）。`);
