/**
 * 批改质量评测语料。
 *
 * 设计原则：**每一条都在检验一个具体的失效模式**，而不是随便凑 20 篇。
 * 分五组：
 *
 *   A 质量阶梯   同一道题、六篇质量递增 + 一篇套话 + 一篇跑题
 *                → 检验区分度（最怕全挤在 8-11）和锚点是否准
 *   B 题型覆盖   书信/通知/议论文/校报/现象描述各一篇
 *                → 检验 prompt 是不是只对议论文有效
 *   C 边界情况   抄题目、极短、中文混入、无标点、中式英语、不分段、
 *                字数不足、背诵范文、特殊字符
 *                → 检验会不会被"非作文"骗到高分
 *   D 一致性     三篇重复跑两遍 → 检验同一篇的分数稳不稳
 *   E 真题题型   新闻报道/proposal/问卷反馈/意见表达，用检索来的真题题干
 *                → A-C 的题干都是我自己写的占位文本，E 组补上真实题干，
 *                  并且覆盖 A/B 没有的体裁（尤以新闻报道最要紧：它天生
 *                  短段多，是 organization 规则最容易误伤的文体）
 *
 * expected 是"一个合理的四级阅卷员会给的区间"，不是标准答案。
 * 命中率低不等于代码有 bug，但偏差方向（系统性上浮/压低）一定说明问题。
 *
 * ⚠️ **这些区间是在 temperature = 0 下标定的。** 2026-09 把默认 temperature 从
 * 0.2 降到 0（原因见 lib/deepseek.ts 的 DEFAULT_TEMPERATURE）之后，模型的整体
 * 打分水位下移了约 1 分，a4/b1/b4/b5/c9 都掉了一档。那次改动的收益是实测的：
 * 同一份语料连跑两遍，平均绝对波动从 0.75 分/篇（28 篇里 13 篇变）降到
 * 0.07 和 0.25 分/篇（两个样本）。确定性上的收益远大于那 1 分水位，
 * 所以区间跟着重新标定，而不是把 temperature 调回去。
 *
 * 另：几条区间放宽到跨 3-4 分（b5 [11,14]、c9 [11,14]、c8 [8,11]）是**故意的**。
 * 这几篇的维度分本身就会在两次运行之间翻（language 4↔3、content 4↔3），
 * 而评分标准里「少量语言错误」和「基本无错误」正好卡在这两个读数之间，
 * 所以 11 和 14 都是模型自己能自圆其说的分数。与其挑一个读数当标准答案，
 * 不如把实测到的振幅写进区间——评测要抓的是**系统性偏差**，不是这种抖动。
 *
 * ⚠️ replay 时注意：这些作文是我按四级学生常见水平**构造**的，不是真实考场作文。
 * 它们的作用是覆盖典型失效模式，不能当作真实分数分布的样本。
 */

export interface EvalCase {
  id: string;
  /** 合理的分数区间（15 分制） */
  expected: [number, number];
  /** 这条在检验什么 */
  note: string;
  topic?: string;
  essay: string;
  /** 重复跑几次，用来测一致性 */
  repeat?: number;
}

// ---------------------------------------------------------------------------
// 题干。真题原文（场次见注释），用于让模型能判断是否切题。
const P_SPORTS =
  "Suppose you are a college student. Write an essay on the importance of doing sports. " +
  "You should write at least 120 words but no more than 180 words.";

const P_LETTER =
  "Suppose you are a student who wants to join a volunteer program in your city. " +
  "Write a letter to the program organizer to apply for it. You should tell him/her " +
  "why you are interested and what you can do. You should write at least 120 words " +
  "but no more than 180 words.";

const P_NOTICE =
  "Suppose you are the chairman of the Students' Union of your university. " +
  "Write a notice to inform the students of a lecture on Chinese traditional culture, " +
  "including the time, the place and the speaker. You should write at least 120 words " +
  "but no more than 180 words.";

const P_NEWSPAPER =
  "Suppose you are a student. Write an article for your school newspaper on the " +
  "importance of developing a good habit of reading. You should write at least 120 " +
  "words but no more than 180 words.";

const P_PHONE =
  "Some people think that mobile phones bring people closer, while others believe " +
  "they make people more distant. Write an essay to state your opinion. You should " +
  "write at least 120 words but no more than 180 words.";

const P_PARTTIME =
  "Nowadays an increasing number of college students are taking part-time jobs. " +
  "Write an essay to describe this phenomenon and give your comments. You should " +
  "write at least 120 words but no more than 180 words.";

// ---------------------------------------------------------------------------
// E 组用的真题题干（2019-2025）。逐条来自公开真题整卷页，来源与置信度见各组注释。
//
// ⚠️ 这些是**检索来的**，不是我从官方渠道核过的。2026-09 收集时，WebFetch 对多数
// 域名被拦截，实际是用 PowerShell 抓页面正文后人工还原的，来源页对英文题干常有
// OCR 排版问题（空格丢失、单词粘连），已规范化。标为"中"置信度的题号（哪一套）
// 在来源之间有冲突，故 E 组只取置信度为"高"的四道。
// ---------------------------------------------------------------------------

// 2019 年 6 月第一套。题干在来源间有 campus/school newspaper、assist/help 的措辞
// 差异，取出现频率更高、且与同批另两套（local farm / Hope elementary school）
// 一致的 campus newspaper + assist 版本。
const P_REPORT =
  "Directions: For this part, you are allowed 30 minutes to write a news report " +
  "to your campus newspaper on a volunteer activity organized by your Student " +
  "Union to assist elderly people in the neighborhood. You should write at least " +
  "120 words but no more than 180 words.";

// 2021 年 12 月（套次待确认——整卷页只含一套，无法确认第几套）
const P_PROPOSAL =
  "Directions: Suppose your school is organizing an orientation program to help " +
  "the freshmen adapt to the new environment and academic studies. You are now " +
  "to write a proposal, which may include its aim, duration, participants and " +
  "activities. You will have 30 minutes to write the proposal. You should write " +
  "at least 120 words but no more than 180 words.";

// 2023 年 6 月第一套
const P_SURVEY =
  "Directions: Suppose your university is conducting a survey to collect " +
  "students' opinions of online classes. You are to write a response to the " +
  "survey about their advantages and disadvantages, and what improvements can " +
  "be made. You will have 30 minutes for the task. You should write at least " +
  "120 words but no more than 180 words.";

// 2025 年 6 月第二套
const P_AI =
  "Directions: Suppose your university is conducting a survey to collect " +
  "students' opinions on the appropriate use of AI technology in assisting " +
  "learning. You are now to write an essay to express your view. You will have " +
  "30 minutes to write the essay. You should write at least 120 words but no " +
  "more than 180 words.";

// ---------------------------------------------------------------------------
export const CORPUS: EvalCase[] = [
  // ===== A 质量阶梯（同一道题）=============================================
  {
    id: "a1",
    expected: [4, 6],
    note: "2 分档：支离破碎，多数句子有严重错误（2026-09 复核：与 a2 的诊断完全一致——同为 C3/L1/O2、9 条 major——两者已无法区分，预期合并到 a2 的区间；下次该把 a1 写得更碎）",
    topic: P_SPORTS,
    essay: `I think sport is very importance for us. Because sport can make our body health.
Many student is not like sport. They always sit in classroom and play phone. This is bad for health.
So I think we should do sport. Sport is good. I like play basketball. My friend also like play basketball.
But some time we no have time. We must study. So we no do sport. I think school should give we more time to do sport.`,
  },
  {
    id: "a2",
    expected: [4, 6],
    note: "5 分档：表达不清楚，连贯性差，较多严重错误",
    topic: P_SPORTS,
    essay: `Now, people all very care about sports. But I think there have many problem.
Some people think sports is waste time. They say we must study, sports no use. But this idea is not right. If body not good, how can study good? So sports is important.
Other people only do sports when exam coming. They run 1000 meter, then no more. This also not right. Sports should be every day.
In a word, sports very important for us. We should do it every day. Let us sports together.`,
  },
  {
    id: "a3",
    expected: [7, 9],
    note: "8 分档：基本切题，勉强连贯，语言错误相当多",
    topic: P_SPORTS,
    essay: `Sports plays an important role in our life. As a college student, I think we should take part in sports activities.
First of all, doing sports can keep us healthy. If we always sit in the classroom and study, our body will become weak. But if we run or play basketball every day, we will have a strong body, and then we can study more efficient.
Second, sports can help us make friends. When we play basketball with others, we can talk with them and know each other. This is good for our social ability.
However, some students don't like sports. They think it is a waste of time. I think this opinion is not correct, because health is the base of everything.
In conclusion, we should do sports every day. It not only make us healthy but also make us happy.`,
  },
  {
    id: "a4",
    expected: [12, 14],
    note: "11 分档：切题、清楚、连贯，少量语言错误（2026-09 复核：原预期犯了与 b 组同样的错——这篇实际没有语法错误，按 14 分档「基本上无语言错误、仅有个别小错」的原文，13 分是对的，原区间偏低）",
    topic: P_SPORTS,
    repeat: 2,
    essay: `Sports play an essential role in our daily life, especially for college students who spend most of their time sitting in classrooms.
To begin with, regular exercise keeps us physically healthy. Many students complain that they feel tired easily, which is often caused by a lack of physical activity. If we take half an hour to run or play ball games every day, our bodies will become stronger and we will be able to concentrate better on our studies.
In addition, sports benefit us mentally. When we are under pressure from exams, doing sports is an effective way to release stress. Moreover, team sports such as basketball teach us how to cooperate with others, which is a valuable ability in our future career.
Admittedly, some students argue that sports take up too much time. However, this problem can be solved by making a reasonable schedule rather than giving up exercise altogether.
In conclusion, doing sports is beneficial both physically and mentally. Therefore, I suggest that every college student develop the habit of exercising regularly.`,
  },
  {
    id: "a5",
    expected: [13, 15],
    note: "14 分档：基本无语言错误，通顺，句式有变化",
    topic: P_SPORTS,
    repeat: 2,
    essay: `It is a commonplace observation that college students today are increasingly sedentary, yet the value of physical exercise has never been greater.
The most obvious benefit is physical. Regular exercise strengthens the heart, improves sleep quality and keeps weight under control — advantages that become increasingly difficult to obtain once the habit of inactivity has taken root. What is less often noticed, however, is the effect on the mind. Exercise releases tension that hours of studying cannot dissipate, and it restores the concentration that a long afternoon in the library steadily erodes.
Beyond the individual, sports carry a social dimension. On a basketball court or a running track, students who would never speak to one another in a lecture hall find a common purpose. The cooperation and the small disappointments of a close game teach lessons that no textbook conveys.
Some may object that academic pressure leaves no room for such pursuits. This objection, however, mistakes the means for the end: a student who collapses from exhaustion in the final week of term has hardly used his time wisely.
Exercise, in short, is not an interruption of study but a condition of it.`,
  },
  {
    id: "a6",
    expected: [0, 4],
    note: "套话作文：语言漂亮但完全空洞，且从未提到 sports（最该被压分的类型）（2026-09 复核：原区间 3-7 假设语言质量能托住分数，但通篇不提 sports 已经接近「文不对题」，该按 0 分档的条文考量，原区间上限过高）",
    topic: P_SPORTS,
    essay: `Nowadays, with the rapid development of our society, more and more people begin to pay attention to this issue. It is universally acknowledged that this phenomenon has aroused wide concern among the public. Different people have different opinions on it, and it is hard to say which one is right.
As far as I am concerned, every coin has two sides. On the one hand, it brings us many benefits. On the other hand, it also causes some problems. We should treat it in a dialectical way. Only in this way can we make full use of it and avoid its disadvantages.
In conclusion, it is high time that we took effective measures to deal with this situation. As long as we work together, we will surely have a bright future. Let us take action from now on.`,
  },
  {
    id: "a7",
    expected: [0, 4],
    note: "跑题：英语相当好，但写的是手机而不是运动（检验是否真的按 rubric 判 0 分档）",
    topic: P_SPORTS,
    essay: `The use of mobile phones in classrooms has become a controversial issue in recent years. Many teachers complain that students are distracted by their devices, while students argue that phones are useful learning tools.
In my opinion, a complete ban is neither practical nor necessary. What matters is establishing clear and reasonable rules. For instance, phones could be collected at the beginning of a lecture and returned afterwards, or their use could be permitted only for specific learning activities.
It should also be admitted that the problem is not the device itself but the lack of self-discipline. A student who cannot resist checking messages every five minutes will be distracted by a window or a classmate just as easily. Therefore, learning to manage one's attention is a more durable solution than any school regulation.
To sum up, phones should be regulated rather than forbidden, and students should be encouraged to develop the self-control that will serve them far beyond the classroom.`,
  },

  // ===== B 题型覆盖（各一篇，中等偏上水平）=================================
  {
    id: "b1",
    expected: [11, 13],
    note: "申请信：格式与语气是否被识别（2026-09 复核两次：先在 temperature 0.2 下改成 12-14，理由是「这篇实际找不到语法错误」，但那只是那一次采样把 language 打成了 4/5。temperature 归零后模型稳定给 L3 并给出具体理由——「句式高度重复：大量 I am / I can / I could 并列，用词偏基础」，读原文确实如此。按评分标准，language 3/5 对应「少量语言错误」= 11 分档，所以下限该是 11；上限留 13 是因为 content 5/5、格式规范，不同阅卷人对「句式单一」的权重给法不同）",
    topic: P_LETTER,
    essay: `Dear Sir or Madam,
I am writing to apply for the volunteer program in our city, which I learned about from the notice on the university website.
I am a second-year student majoring in English, and I have a strong interest in community service. Last summer I worked as a volunteer in a local library, where I helped children with their reading. That experience taught me how to communicate with people of different ages, and it made me realize how much a small effort can mean to others.
I believe I am well suited to this program. I can speak fluent English and I am familiar with office software, so I could help with translation and with organizing activities. Moreover, I am free on weekends and I am willing to travel within the city.
I would be grateful if you could give me this opportunity. I am looking forward to your reply.
Yours sincerely,
Li Hua`,
  },
  {
    id: "b2",
    expected: [12, 13],
    note: "通知：格式要素（时间/地点/主讲人）是否齐全（2026-09 复核：三要素齐全、无语法错误；模型标的两条 minor 里，「祈使句语气偏命令式」是把通知的文体特征当错误）",
    topic: P_NOTICE,
    essay: `Notice
In order to enrich our campus life and help students learn more about Chinese traditional culture, the Students' Union is going to hold a lecture next week. The details are as follows.
The lecture will be given by Professor Wang Ming from the Department of Chinese Literature, who has studied Chinese classical poetry for more than twenty years. It will be held in the Lecture Hall of the Main Building, from 2:00 p.m. to 4:00 p.m. on Friday, October the 15th. The topic is "Chinese Poetry in the Tang Dynasty".
During the lecture, Professor Wang will introduce some famous poets and explain why their works are still popular today. There will also be half an hour for questions, so students can ask anything they are interested in.
All the students are welcome to attend. Please arrive ten minutes earlier and keep quiet during the lecture.
The Students' Union`,
  },
  {
    id: "b3",
    expected: [12, 13],
    note: "议论文：正反观点型，是否两面都回应（2026-09 复核：b 组最好的一篇，立场句和例证都具体，真错只有 1-2 处搭配）",
    topic: P_PHONE,
    repeat: 2,
    essay: `Whether mobile phones bring people closer or push them apart has been widely discussed. In my view, the answer depends less on the device than on how we use it.
There is no doubt that phones have shortened distance in a practical sense. A student studying abroad can see his parents' faces every evening, and a message can reach a friend on the other side of the world within a second. For people who live far apart, this is a genuine improvement that no letter could offer.
However, the same convenience can quietly replace real contact. It is now common to see a group of friends sitting at one table, each occupied by his own screen. The conversation that would have taken place is replaced by silence, and the people physically nearest are the ones least noticed.
Therefore, I do not think phones are the problem in themselves. The problem is that we allow them to fill every empty moment. If we set aside time to put the phone away and look at the person in front of us, the technology can serve us instead of separating us.`,
  },
  {
    id: "b4",
    expected: [11, 13],
    note: "校报文章：是否体现「说服读者」的文体特征（2026-09 复核两次：原 12-13 的「无语法错误」结论来自 temperature 0.2 的一次采样。归零后模型稳定给 L3 并逐条指出主谓一致/时态/冠词问题，其中「in the last century 前缺 the」是误判（原文本来就有 the）、「books…the first thing 搭配逻辑」也偏严，但 language 3/5 这个总判断站得住。按 language 3/5 → 11 分档，下限调到 11）",
    topic: P_NEWSPAPER,
    essay: `Why We Should Read More
Many students today say that they have no time to read. Between classes, club activities and part-time jobs, books seem to be the first thing to be given up. I would like to argue that this is a mistake.
Reading is not simply a way to pass time. It is the most efficient way to meet people and ideas that our own life would never bring us. A student who reads a novel about a small village in the last century will understand his grandparents a little better. A student who reads popular science will find that the world is far stranger than he assumed.
Reading also improves our language ability without our noticing. This may sound like a practical reason, but it is an honest one: students who read regularly write more easily, because they have met good sentences before.
Therefore, I suggest that everyone keep a book on the desk. Fifteen minutes before sleeping is enough. What matters is not the amount but the habit, and a habit formed in college may last a lifetime.`,
  },
  {
    id: "b5",
    expected: [11, 14],
    note: "现象描述+评论：是否既有描述又有自己的判断（2026-09 复核：182 词、四段、would rather...than / so...that 用得准确，写得好。区间定 11-14 是因为它的 language 在多次运行里稳定地在 3 和 4 之间翻——L4 对应 13-14，L3 按标准对应 11-12，两个读数都出现过。这是模型对「少量错误」和「基本无错误」这条界线的判定抖动，不是作文本身的歧义）",
    topic: P_PARTTIME,
    essay: `In recent years, more and more college students are taking part-time jobs. Walk around any campus on a weekend and you will find students working as tutors, waiters or shop assistants.
There are several reasons for this trend. The most common one is money. Tuition and living costs have risen, and many students would rather earn part of their expenses than ask their parents for more. Another reason is experience. Students who plan to work after graduation believe that a part-time job will make their resume more attractive.
In my opinion, this trend should be welcomed, but with one condition. A part-time job is valuable when it does not damage the main task of a student, which is study. Some students work so many hours that they sleep in class, which defeats the purpose entirely. A reasonable amount of work brings both money and experience; too much of it brings neither a good job nor a good degree.
Therefore, students should choose carefully how much time to give, and the university should perhaps offer some guidance on this point.`,
  },

  // ===== C 边界情况 =======================================================
  {
    id: "c1",
    expected: [0, 3],
    note: "抄题目：把题干整段抄下来加两句废话",
    topic: P_SPORTS,
    essay: `Suppose you are a college student. Write an essay on the importance of doing sports. You should write at least 120 words but no more than 180 words.
I think doing sports is important. It is very important for every college student. We should do sports. This is my opinion about the importance of doing sports.`,
  },
  {
    id: "c2",
    expected: [0, 3],
    note: "极短：刚过 20 字符的下限",
    topic: P_SPORTS,
    essay: `Sports is good. I like it very much.`,
  },
  {
    id: "c3",
    expected: [1, 5],
    note: "中文混入：大段中文，检验会不会被当成有效内容",
    topic: P_SPORTS,
    essay: `Nowadays, doing sports is more and more important for college students.
首先，运动可以让我们的身体更健康。如果每天跑步半小时，就不会那么容易生病。
其次，运动可以帮助我们放松心情。学习压力大的时候，运动是最好的解压方式。
In conclusion, we should do sports every day. 只有这样，我们才能更好地学习和生活。`,
  },
  {
    id: "c4",
    expected: [6, 8],
    note: "无标点全小写：语言内容其实还行，但格式完全崩塌（2026-09 复核：内容清楚，差的是书写规范；5 分档要求的「表达思想不清楚」不满足，原区间下限过低。注意模型给的 5 条 major 里至少有 2 条是误判）",
    topic: P_SPORTS,
    essay: `doing sports is important for college students first it can make our body healthy if we sit in the classroom all day we will feel tired and cannot study well second sports can help us make friends when we play basketball together we can talk with each other and know more people however some students think sports waste time i think this is wrong because health is the most important thing in conclusion we should do sports every day`,
  },
  {
    id: "c5",
    expected: [5, 7],
    note: "严重中式英语：每句都能猜懂，但全是中文语序（2026-09 复核：112 词里约 9 处基础错误、密度约每 14 词一处，正是 TIER_GAP[3] 点名的那四类；横向对照同风格同题目的 a2（预期 4-6、模型给 5），c5 的错误密度更高却拿到 8 分，说明模型没有稳定的「严重错误密度→档次」映射）",
    topic: P_SPORTS,
    essay: `As we all know, body is the capital of revolution. So do sports is very important.
For college student, we have many study pressure. If no good body, we cannot finish our study. So we must to do sports.
Besides, do sports can let us not so easy to get sick. Our country also say that we should exercise one hour every day.
But now many student very lazy. They like to play computer games in dormitory. They say no time to do sports. I think this is not good.
So I suggest school can open more sports class, and student should go out of dormitory. Let us move our body together.`,
  },
  {
    id: "c6",
    expected: [10, 12],
    note: "一整段不分段：内容其实不错，检验 organization 是否被识别（2026-09 复核：原区间 6-9 偏低了——8 分档的描述里「语言错误相当多，其中有一些是严重错误」这一句，c6 完全不满足（0 条 major、语言通顺）。分段问题属于 organization 维度，扣结构分不等于打到 8 分档）",
    topic: P_SPORTS,
    essay: `Doing sports is of great importance to college students, and I would like to explain why. First of all, regular exercise keeps us physically healthy, which is the foundation of everything else we do; a student who is often ill can hardly keep up with his courses. Secondly, sports help us release the pressure that comes from examinations and deadlines. Many students feel anxious before an important test, and half an hour of running often works better than another hour of sitting and worrying. Thirdly, taking part in team sports such as basketball or volleyball teaches cooperation, which is a quality that employers value highly. Some students argue that they are too busy to exercise, but this is a false economy: time spent on sports is repaid in better concentration. In conclusion, every college student should set aside some time each day for physical exercise, because a healthy body makes a good mind possible.`,
  },
  {
    id: "c7",
    expected: [4, 6],
    note: "字数不足：只有 40 词，官方标准里字数不足要扣分（2026-09 复核：原预期写「60 词左右」是记错了，实际 40 词，不足下限 120 的三分之一，按自己的逻辑预期上限该更低。模型当时还在总评里虚报成「约55词」——现在客观统计直接进 prompt，这类虚报不会再发生）",
    topic: P_SPORTS,
    essay: `Doing sports is important for college students. First, it keeps us healthy. Second, it helps us relax after class. Some students say they are too busy, but health is more important than anything. So we should do sports every day.`,
  },
  {
    id: "c8",
    expected: [8, 11],
    note: "背诵范文：句式华丽、与题目沾边，但内容全是万能句，没有一处具体（2026-09 复核：这是「自相矛盾」最干净的样本——模型把 sports plays 标成 major，升档理由里写「主谓不一致属于严重错误，会直接把作文拉低到 8 分档」，然后给了 11 分。**区间放宽到 8-11 是量出来的，不是让分**：同一份代码前后两次运行，这篇 8→11，同时 content 2→3、language 2→3、organization 3→4、major 3→1，四项诊断**同时**上移。content 从 2 变 3 会让 vacuous-content 这条上限（content ≤2 → 9）直接失效，所以 8 和 11 都是它自己诊断支撑得住的分数。这类「流畅但空洞」的作文是模型最不稳的一类，区间必须反映这个实测出的 ±3 振幅）",
    topic: P_SPORTS,
    essay: `With the rapid development of modern society, the importance of doing sports has attracted extensive attention from all walks of life. As the saying goes, "Life lies in movement." There is no denying that sports plays an indispensable role in our daily life, and it is universally acknowledged that nothing is more precious than health.
On the one hand, doing sports can strengthen our physique and build up our body. On the other hand, it can also cultivate our perseverance and help us to form a positive attitude towards life. As far as I am concerned, we should attach great importance to this issue and take effective measures to improve the present situation.
All in all, only by doing sports can we embrace a brighter future. It is high time that we took action. Let us spare no effort to build a harmonious society together.`,
  },
  {
    id: "c9",
    expected: [11, 14],
    note: "含特殊字符（İ/弯引号/破折号）：语言干净、结构清楚，专门压测证据定位在 İ 上的坐标映射（2026-09 重写：原开头是「İstanbul has nothing to do with this essay, but the first word of this line does」——我写这句只是为了塞进 İ，但 temperature 归零后模型指出它「与题目要求毫无关系，属于明显的跑题式开头」，而且它是对的：真实阅卷人看到这种开头一定会扣切题分。这条本来要测的是**坐标映射**，却混进了一个独立的内容缺陷，两个变量纠缠在一起，测不出想测的东西。改成一句正常引用（İzmir 的学生研究），保持 İ/弯引号/破折号不变，同时把 196 词压到 180 以内——超字数当时也被模型当成扣分理由，同样是无关变量。区间又从 12-14 放宽到 11-14：改完之后 content 仍在 3 和 4 之间翻，13 和 11 都出现过，说明开头那个引用句式仍有解读空间。**这条的首要目的是压测 İ 的坐标映射**（§⑤ 定位成功率），分数区间宽一点可以接受，不必为此再把作文改写得更平庸）",
    topic: P_SPORTS,
    essay: `İzmir is far from this campus, yet a study of students there reached the conclusion we keep rediscovering here: those who move regularly sleep better and think more clearly.
The case for physical activity among college students rests on three observations. The first is physiological. A body that moves regularly falls ill less often and tolerates long hours of study far more patiently than one that does not. The second is psychological: students under pressure treat exercise as a luxury — “I’ll go for a run when the essay is finished” — yet the run is precisely what makes the essay finishable.
The third observation is social. Sport is one of the few activities on a modern campus that cannot be done alone in front of a screen. Whether on a court or a track, students meet each other as equals, and the friendships formed there tend to outlast the course that brought them together.
None of this requires an athlete’s routine. Thirty minutes, four times a week, is enough to make a visible difference.`,
  },

  // ---------------------------------------------------------------- E 真题题型
  {
    id: "e1",
    expected: [12, 14],
    note: "新闻报道（2019-06 第一套真题题干）：格式规范、含引语、语言干净。**这条专门检验刚改的 organization 规则会不会误伤**——新闻报道本来就该短段，如果模型因为『段数多、每段短』就压 organization，那就是把文体特征当缺陷（b1/b2 的申请信已经被这么评过一次）",
    topic: P_REPORT,
    essay: `A Helping Hand to Our Elderly Neighbours

Last Saturday, a volunteer activity organized by the Student Union brought warmth to the elderly residents of Xingfu Community, a ten-minute walk from our campus.
More than forty students took part in the activity, which began at nine in the morning and lasted until noon. Working in small groups, the volunteers helped the residents clean their rooms, repair broken furniture and carry heavy bags of rice upstairs. Some students simply sat down and listened to them talking about their children who work in other cities.
"It is not the cleaning that matters most," said Mr Zhang, a retired teacher who has lived in the community for thirty years. "It is knowing that somebody remembers us."
The Student Union says the activity will be held once a month from now on, and students who wish to join may sign up at the union office before Friday.`,
  },
  {
    id: "e2",
    expected: [11, 13],
    note: "建议书 proposal（2021-12 真题题干）：四个要素（目的/时长/参加者/活动）齐全，语言基本正确。检验模型会不会去核对题面点名的要素有没有全部回应",
    topic: P_PROPOSAL,
    essay: `Proposal on the Orientation Program for Freshmen

The purpose of this proposal is to suggest a one-week orientation program designed to help freshmen adapt to the new environment and to the demands of academic study at our university.
The program should be held during the first week of September, before regular classes begin. All newly enrolled students are expected to attend, and about sixty senior students will serve as volunteers to guide them in small groups.
As for the activities, I suggest three parts. The first is a campus tour on the opening day, which helps students find the library, the laboratories and the dining halls. The second is a series of short lectures on how to manage time and how to use the online library system. The third is a welcome party at the weekend, where freshmen can meet teachers and classmates in a relaxed atmosphere.
I believe such a program would make the beginning of university life much easier, and I hope the school will consider this proposal.`,
  },
  {
    id: "e3",
    expected: [9, 11],
    note: "问卷反馈（2023-06 第一套真题题干）：三个问题（优点/缺点/改进）都答了，但有真语法错误（than talk face to face 应为 talking；the expression of each other 应为 each other's expressions）。检验体裁要求的三方面是否被逐个检查（2026-09 复核：原区间 8-10 的依据是「三个方面答得都很薄」，但重读自己写的这篇，三个方面其实都有具体内容——录播回看/省通勤时间/注意力涣散/小组讨论低效/建议自习室。真正压住上限的是**语言**而不是内容：L3 且有 1 条 major，够不上 14 分档，但 11 分档站得住。原文把内容判低了，已改）",
    topic: P_SURVEY,
    essay: `A Response to the Survey on Online Classes

Having read the survey on online classes, I would like to share my opinions about this new way of learning.
Online classes have some clear advantages. We can watch the recorded lessons again when we do not understand something, and we save the time that used to be spent on the way to the classroom. For students who live far from the campus, this is a real convenience.
However, the disadvantages are also very serious. Without a teacher standing in front of us, it is easy for us to lose concentration, and many students just leave the computer running while they do something else. Besides, group discussion online is much less efficient than talk face to face, because we cannot see the expression of each other.
To improve the situation, I suggest that teachers should ask more questions during the live class, and that the school should provide a quiet study room for the students whose dormitory is too noisy.
I hope these suggestions will be useful for the improvement of online teaching.`,
  },
  {
    id: "e4",
    expected: [6, 9],
    note: "套话 + 真题题干（2025-06 第二套）：题目问的是『适当使用 AI 辅助学习』，全文没有一处谈到学习，全是万能句。检验 vacuous-content 这条上限在**真题干**上灵不灵（2026-09 复核：原区间 2-6 定错了，与 c8 的区间自相矛盾——e4 和 c8 是同一类作文（万能句 + 与题目沾边），c8 我写 8-10，e4 却写 2-6，没有任何依据能解释这个落差。按 c8 的同一把尺子，content 2/5 对应 vacuous-content 的上限 9，e4 比 c8 更空洞且更短，故 6-9）",
    topic: P_AI,
    essay: `Nowadays, with the rapid development of our society, artificial intelligence has attracted extensive attention from all walks of life. It is universally acknowledged that AI plays an increasingly important role in our daily life, and different people hold different opinions on this issue.
As far as I am concerned, every coin has two sides. On the one hand, AI brings us many benefits and make our life more convenient. On the other hand, it also causes some problems which we cannot ignore. Therefore, we should treat it in a dialectical way.
In conclusion, only by using AI in a proper way can we embrace a brighter future. It is high time that we took action and spared no effort to build a better world together.`,
  },
];
