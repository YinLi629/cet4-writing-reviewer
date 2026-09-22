/**
 * 训练区的练法查表。
 *
 * ## 这个文件解决什么
 *
 * 批改报告原本到"证据溯源"就结束了——告诉你哪里错了，但没回答"我这种反复出现的
 * 毛病，平时该怎么避免"。这里是那个落点：按**错误类型**（不是评分维度）给出
 * 「写作时怎么做」+「平时怎么练」。
 *
 * ## 为什么是查表，不是让模型写
 *
 * 练法是**可迁移到下一篇**的通用动作，不是对这篇作文的判断。让模型生成有三个问题：
 * 没法写断言（项目不引入前端测试框架，selftest 是唯一的自动验证抓手）、措辞会飘、
 * 而且模型在给不出具体动作时会退化成"多读多写"这类正确的废话。
 *
 * 所以分工是：**模型只负责诊断**——从下面的枚举里挑出这篇最该练的 1-3 项，
 * 并说明为什么（必须引用本篇的具体现象）。练法文案由这里查表填充。
 *
 * ## 文案的写法：写动作，不写态度
 *
 * "要细心""多积累""多读多写"一条都不出现——学生看完那些等于没看。每一条都要是
 * 一个**当场能做的动作**（"从最后一段往回读"、"把所有动词圈出来"）。
 * `watchOut` 尤其重要：这几类毛病里"越练越糟"的情况很常见（学生被纠正后矫枉过正），
 * 不写出来反而会把人带偏。所以它在类型上是**必填**。
 *
 * ## ⚠️ 和 rubric 的耦合只有一半
 *
 * 13 个 focus 里，5 个直接对应 lib/prompt.ts 的 KIND_RULES 里 major 的说法，
 * 3 个对应 minor 的说法，**另外 5 个（word-choice / sentence-variety / cohesion /
 * paragraphing / task-response）在 rubric 里没有对应说法**，是本轮新造的词。
 *
 * 这意味着：**改了 rubric 的错误分类，这里不会自动跟着变。** 改的时候回来对一眼。
 *
 * ⚠️ 增删 focus 要同步三处：lib/types.ts 的 TrainingFocus、本文件的
 * TRAINING_PLAYBOOK、lib/labels.ts 的 TRAINING_FOCUS_LABEL。
 * 前两处漏了会被 TypeScript 挡住（`Record<TrainingFocus, …>` 要求键齐全），
 * 标签漏了不会——scripts/selftest.ts 有专门的断言兜。
 */

import type { Dimension, TrainingFocus } from "./types";

export interface TrainingPlaybook {
  /** 一句话说明"这个毛病在你的作文里长什么样"，让学生能自己对上号 */
  symptom: string;
  /** 写作时怎么做。3-4 条，每条都是当场可执行的动作 */
  howTo: string[];
  /** 平时怎么练。2-3 条，具体到"练什么、练几次" */
  drills: string[];
  /**
   * 常见误区——越练越糟的那种。
   *
   * **必填**，不给可选：这几类毛病里矫枉过正太常见了（学生被纠正主谓一致之后
   * 在集合名词上乱加 s），不主动说，练法本身会制造新错误。
   */
  watchOut: string;
}

/**
 * 练法查表。
 *
 * 注意这里**没有 label 字段**——标签统一放在 lib/labels.ts 的 TRAINING_FOCUS_LABEL。
 * 同一个字符串有第二个真相源，就会出现"改了一个忘了另一个"，而网页和导出报告
 * 各显示一种措辞，用户会以为是两回事（lib/labels.ts 头注释讲的就是这件事）。
 */
export const TRAINING_PLAYBOOK: Record<TrainingFocus, TrainingPlaybook> = {
  spelling: {
    symptom:
      "同一个词在不同段落里拼法不一致，或反复拼错同一类词（如 -tion / -sion、双写辅音）。",
    howTo: [
      "拿不准的词换掉，别赌。四级作文的词汇量要求不高，用你会拼的同义词替换（make sure → ensure 拿不准就用前者）。",
      "交卷前留 2 分钟只扫拼写：从最后一段往回读，倒着读能逼你看单词本身，而不是被句子意思带着走。",
      "专有名词、时间、数字一律用最简单的写法，不要在考场上尝试没写过的词。",
    ],
    drills: [
      "把这次批改标出的错词抄成一张「我的错词表」，只记你真正写错过的词，不要抄词表书。",
      "下次动笔前花 30 秒默一遍这张表；写完再对一遍。同一个词连对三次就从表里划掉。",
    ],
    watchOut:
      "别指望拼写检查——四级是手写，考场上没有工具。平时用软件写惯了，考场上会原形毕露。",
  },

  capitalization: {
    symptom:
      "句首字母漏写大写、专有名词小写（china / english / monday），或人称代词 I 写成了小写 i。",
    howTo: [
      "每写完一句就回头看第一个字母。一句一查比最后通查快得多，这是最容易漏也最容易抓的一处。",
      "需要大写的专有名词其实只有几类：国家/语言/人（China, Chinese, English）、星期与月份（Monday, January）、书名与标题。其余基本不用大写，拿不准就写小写。",
      "人称代词 I 在任何位置都大写。就一个字母，阅卷时却特别扎眼。",
    ],
    drills: [
      "把自己写过的作文翻出来，只圈每句的第一个字母，看有没有漏。一次就能暴露习惯性漏写。",
      "写一小段关于自己的话，刻意用上 3 个国家名和 3 个星期，写完专查这几个词。",
    ],
    watchOut:
      "不要为了保险把词全大写——英语里没有这种做法，通篇大写等于没写对，而且读起来很吃力。",
  },

  tense: {
    symptom:
      "同一段里现在时和过去时来回跳；议论文里混进了描述过去事件的时态。",
    howTo: [
      "动笔前先定一个基准时态，写在草稿纸角上。四级作文绝大多数是议论文 → 通篇一般现在时。",
      "只有举例讲个人经历时允许切到过去时，切完立刻切回来；一次例子里不要来回切。",
      "写完专门查一遍动词：把所有动词圈出来，看有没有哪个和基准时态不一致。",
    ],
    drills: [
      "找一篇自己的旧作文，只圈动词、不看别的，逐个判定时态对不对。这个动作练三次就能形成条件反射。",
      "背 10 个最常用动词的过去式（think/thought、take/took…），写错时态的多半就是这几个。",
    ],
    watchOut:
      "不要为了「保险」通篇用过去时——议论文用过去时反而会显得跑题。基准时态要按文体定，不是按哪个安全。",
  },

  agreement: {
    symptom:
      "第三人称单数漏 s（he go to school）、主语和谓语数不一致（The number of students are…）、there be 后面跟了复数。",
    howTo: [
      "写完一句先找主语的中心词，**不看修饰语**。The number of students 的主语是 number（单数），不是 students——of 短语里的名词不算主语。",
      "一般现在时里，主语是 he/she/it 或单个的人、物、事，动词加 s；其余用原形。先判断主语单复数，再写动词。",
      "there be 的 be 跟着后面**第一个**名词变：There are many reasons，不是 There is。",
    ],
    drills: [
      "专练第三人称单数：随便找 10 个动词，给每个写出 he ___ 的形式，错一个就把那个词记下来。",
      "把自己作文里所有谓语动词圈出来，逐个用「主语是单数还是复数」重新判一遍。",
    ],
    watchOut:
      "别一看见主语是复数就加 s、一看见 -s 结尾的名词就当复数——news、physics、the United States 都是单数。矫枉过正比漏改更常见。",
  },

  "noun-article": {
    symptom:
      "可数名词单数前缺冠词（I want to be teacher）、a/an 用错、该用复数的地方用了单数、不可数名词加了 s（informations、advices）。",
    howTo: [
      "写可数名词单数之前先决定它前面要不要 a/an/the，或者是不是该用复数——英语里可数名词单数不能光着出现，这是硬规则。",
      "泛指用复数或 a/an，特指（上文提过、独一无二）用 the。拿不准的时候用复数最安全。",
      "记一批常考的不可数名词：information、advice、news、furniture、equipment、progress、knowledge。这些永远不加 s。",
    ],
    drills: [
      "把作文里所有名词圈出来，每个标三项：可数/不可数、单数/复数、前面有没有冠词。三项都标完再回头改。",
      "背 10 个固定搭配（in the morning、at night、go to school、play the piano）——这类搭配比规则更常考。",
    ],
    watchOut:
      "不要给不可数名词加 s 来表示「很多」——要说 a lot of information，不是 informations。这个错比漏冠词更扎眼。",
  },

  "sentence-structure": {
    symptom:
      "从句单独成句（Because it is convenient.）、两个完整句子用逗号连在一起、句子缺主语或谓语。",
    howTo: [
      "写完一句就检查：有没有主语、有没有真正的谓语动词？Because it is convenient. 主语谓语都有，但 because 让它成了从句，它必须挂在一个主句上。",
      "两个完整的句子不能用逗号连接。要么用句号断开，要么加 and/but/so，要么把其中一个改成从句。",
      "写长句前先写短句。确定每个短句都完整，再决定要不要合并——反过来做最容易崩。",
    ],
    drills: [
      "拿自己的作文，把每个逗号都当成可能的断句点，逐个数：这句话数到两个完整谓语了吗？数到就拆开。",
      "抄 5 个范文里的长句，用括号标出主句在哪、从句在哪。练几次之后自己写长句时脑子里会自动分。",
    ],
    watchOut:
      "别用「句子越长越显得水平高」来判断——一个写崩的长句比两个干净的短句扣分多。四级看重的是准确。",
  },

  chinglish: {
    symptom:
      "先想中文再逐字翻译，出现英语里不存在的搭配或句式（如 open the light、very miss you）。",
    howTo: [
      "写句子前先问「英语里有没有人这么说」，想不出就直接换一个你见过的说法，不要现场造。",
      "一句话写完回头看主语：英语每句必须有明确主语，中文里可以省略的主语在英语里不能省。",
      "宁可用短句。四级阅卷看重准确，两个短句各 8 词，好过一个 20 词的复合句写崩了。",
    ],
    drills: [
      "把这次标出的中式句子单独抄下来，每句改写成你自己确定对的版本，隔一天再默写一遍。",
      "平时读范文时只做一件事：把「我会怎么写」和「范文怎么写」对照着看，不背整篇。",
    ],
    watchOut:
      "别用机器翻译整段再抄——翻译腔是中式英语的重灾区，而且阅卷时一眼能看出来。",
  },

  collocation: {
    symptom:
      "每个词都对，但放在一起英语里没人这么说（open the light、learn knowledge、do a decision）。",
    howTo: [
      "动宾搭配最容易错：先想「这个动作英语里用哪个动词」，不要从中文动词直译。「开灯」是 turn on the light，不是 open。",
      "拿不准就换成有把握的说法，哪怕简单。想把「获得知识」写成 get knowledge，不如直接写 learn a lot。",
      "积累搭配时**按动词记**，不按名词记：记住 make 后面能接 decision/mistake/progress，比单独背 decision 有用。",
    ],
    drills: [
      "把这次标出的搭配错误抄成三列：我写的 / 应该是 / 中文原意。只抄错过的，不要抄搭配词典。",
      "读范文时专门做一件事：只看动词和它后面接的名词，把拿不准的抄下来查一次。",
    ],
    watchOut:
      "不要为了躲开搭配错误就把动词简化成 do/make/get 用到底——do a decision、make a progress 同样是搭配错误，而且更显眼。",
  },

  "word-choice": {
    symptom:
      "用词太重或太轻（用 fantastic 形容小事）、词性用错（把 success 当动词）、褒贬用反。",
    howTo: [
      "先确认词性：这个位置要的是动词、名词还是形容词？I want to success 里 success 是名词，该用 succeed。",
      "形容词分强度。very good / excellent / fantastic 的程度完全不同，写普通的事别用最强的词——堆大词反而显得不准确。",
      "拿不准一个词的确切含义时就换成你确定的小词。significant 你到底想说「重要」还是「数量大」？想不清就写 important 或 big。",
    ],
    drills: [
      "把作文里所有形容词和副词圈出来，逐个问：删掉它句子还成立吗？成立就说明它没起作用，换成更准的或者直接删。",
      "整理一张「我老是用错的词」表，写清它是什么意思、我原来以为它是什么意思。",
    ],
    watchOut:
      "不要靠背同义词表来「升级用词」——换上去的近义词往往搭配或语气不对，反而制造新错误。一个准确的小词比一个用错的大词得分高。",
  },

  "sentence-variety": {
    symptom:
      "通篇只有「主语 + 动词 + 宾语」一种句式；每句都以 I/We/People 开头；句子长度都差不多。",
    howTo: [
      "一段里至少安排一句不同开头的：用状语开头（With the development of…）、用从句开头（Although…）、或者用 there be。",
      "长短交替。连着三句都超过 20 词就插一个短句；连着三句都很短就合并其中两句。",
      "写完一段数一数：几句话是以同一个词开头的？超过三句就改掉其中两句。",
    ],
    drills: [
      "拿自己的一段作文，把每句开头的词抄成一列，看重复了几个。这个动作最快暴露句式单一。",
      "把同一句话用三种不同开头各写一遍（状语开头 / 主语开头 / there be），练三次就有手感。",
    ],
    watchOut:
      "别为了变化硬套倒装、强调句——用错了比句式单一扣分更多。变换**开头**和**长短**就够了，不需要动句子结构本身。",
  },

  cohesion: {
    symptom:
      "句子之间靠意思硬接、没有过渡；连接词只剩 and/but/so；或者每句都挂一个 First/Second/Last。",
    howTo: [
      "段与段之间用一句话收上一段、起下一段（Besides convenience, there is another reason.），读者才知道你要转向了。",
      "连接词按功能选：转折（however, nevertheless）、递进（moreover, in addition）、因果（therefore, as a result）、举例（for instance）。不要在同一个句子里连用三个 and。",
      "代词回指要明确。连着用 it/this 指不同的东西，读者会跟丢——该重复名词就重复。",
    ],
    drills: [
      "把作文里所有连接词抄成一张表，标上属于哪一类（转折/递进/因果/举例）。哪一类一个都没有，就是缺哪一类。",
      "找一篇范文，把连接词全划掉再读一遍，体会哪里读不通——那些位置就是你该加的地方。",
    ],
    watchOut:
      "不要每句开头都挂一个连接词。连接词是路标不是装饰，密到一个句子一个，读起来反而很机械。",
  },

  paragraphing: {
    symptom:
      "全文一段到底，或者分段和内容对不上：一段只有一句话，或者把两个不同的论点塞进同一段。",
    howTo: [
      "动笔前先列提纲，一句话一个要点。**一个要点一段**——这是最简单也最稳的分段依据。",
      "四级作文 120-180 词通常分 3 段：引入 + 主体（1-2 个理由）+ 结论。写完数一下段数，一段到底一定不合格。",
      "转到新论点时另起一段，不要用 Also 在同一个段落里硬接第二个理由。",
    ],
    drills: [
      "拿自己的旧作文，把每段第一句抄出来。如果这几句连起来读不出文章的思路，就是分段没分对。",
      "找一篇范文，遮住正文只看每段第一句，试着复述全文——练这个能学会「一段一个要点」。",
    ],
    watchOut:
      "不要为了凑段数把一句话拆成一段。分段是按意思分的，一段一句话会让文章显得零碎，同样扣分。",
  },

  "task-response": {
    symptom:
      "没回应题目的全部要求（问原因却只写了现象）、写了题目没问的内容、立场含糊不清。",
    howTo: [
      "动笔前把题目拆成几个问句，圈出所有要求：谈原因？给建议？比较两方？写完回头逐条对，看每一条都回应了没有。",
      "第一段就把立场说清楚。四级作文不需要含蓄，直接写「我认为……，理由有两点」。",
      "留 1 分钟查有没有跑题：把每段第一句连起来读，看它们是不是都在回答题目。",
    ],
    drills: [
      "找 5 个真题题目，每个只做一件事：把题目要求拆成 2-3 个问句写下来，不写作文。练这个能改掉「看个大概就动笔」的习惯。",
      "把自己写过的作文和对应题目放一起，逐句问「这句在回答题目的哪个要求」。答不上来的句子就是跑题的部分。",
    ],
    watchOut:
      "不要背一个模板套所有题目。模板能保证结构，保证不了切题——题目问原因，你套一段「利弊分析」照样是跑题。",
  },
};

/**
 * 合法 focus 的列表，**从查表派生**而不是手写数组。
 *
 * 为什么要派生：这个数组是喂给模型的**合法枚举**（见 lib/prompt.ts 的
 * TRAINING_RULES），而 `TrainingFocus[]` 这个类型**允许漏项和重复**。
 * 手写的话，给 union 和 TRAINING_PLAYBOOK 都加了新类别、却忘了改数组，
 * 查表是齐的、TypeScript 不报错、断言也过——**但模型永远不知道这个类别存在**。
 * 派生之后这种漂移不可能发生。
 */
export const TRAINING_FOCUSES = Object.keys(TRAINING_PLAYBOOK) as TrainingFocus[];

/**
 * focus → 评分维度。模型没给 linkedEvidenceIds 时用它自动挂同维度的证据
 * （见 lib/review.ts 的 parseTrainingPlan），报告里才能从训练项跳回证据卡。
 *
 * 明显偏向 language 是对的，不是偏袒：拼写、时态、搭配这些本来就都归语言维度。
 * 只有分段/衔接归结构、切题归内容。
 */
export const TRAINING_FOCUS_DIMENSION: Record<TrainingFocus, Dimension> = {
  spelling: "language",
  capitalization: "language",
  tense: "language",
  agreement: "language",
  "noun-article": "language",
  "sentence-structure": "language",
  chinglish: "language",
  collocation: "language",
  "word-choice": "language",
  "sentence-variety": "language",
  cohesion: "organization",
  paragraphing: "organization",
  "task-response": "content",
};

/**
 * 把模型给的字符串收敛成一个合法 focus，认不出就返回 null。
 *
 * **归一化"写法"，拒绝"未知语义"——两件事，别混。**
 * 先 trim + toLowerCase，所以 "SPELLING" / " Spelling " 都能收（对齐 lib/review.ts
 * 的 asDimension，它也是先归一化再比）。但只有精确落在枚举里的才通过，
 * 拼错的、中文的、数字的一律 null。
 *
 * 为什么不像 coerceKind 那样兜底：kind 有"最轻的一档"（minor）可以兜，
 * 兜错了只是颜色和严重度偏轻；focus 兜到任何一类都是**给出一整套错误的练法**，
 * 比少一条糟得多。所以这里宁可丢。
 *
 * 反过来说，**大小写也不能当非法值丢掉**：整篇只有 1-3 条训练项，
 * 因为模型把首字母大写了就静默少一条，代价太大了。
 */
export function coerceTrainingFocus(v: unknown): TrainingFocus | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (TRAINING_FOCUSES as string[]).includes(s) ? (s as TrainingFocus) : null;
}
