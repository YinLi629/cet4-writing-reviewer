/**
 * 示例作文，纯粹为了方便试跑。
 * 三篇分别对应低 / 中 / 高三档，用来检查报告在不同分数下排版是否都正常。
 */

export interface SampleEssay {
  id: string;
  label: string;
  /** 预期落在哪一档，仅作标注 */
  hint: string;
  topic: string;
  text: string;
}

export const SAMPLE_ESSAYS: SampleEssay[] = [
  {
    id: "weak",
    label: "问题较多的一篇",
    hint: "预期 5 分档左右",
    topic:
      "Suppose you are a student who wants to join a volunteer program. Write a letter to the program organizer to apply for it. You should write at least 120 words.",
    text: `Dear Sir,

I am a student want to join your volunteer program. I very like help other people. When I see your poster in the school, I am very exciting, so I write this letter.

I think I have many advantage. First, I am hardworking and I can do many thing. Second, I have a lot of free time, because my class is not very busy. Third, I like children very much, so I can take care of they.

Last year I also join a activity about clean the park. I and my classmate go there and pick up the rubbish. It is very tired but I feel happy. So I think I have some experience about volunteer work.

If you give me this chance, I will work very hard. I can do anything you tell me. Please contact with me, my phone number is 138xxxx.

Thank you very much.

Yours,
Li Ming`,
  },
  {
    id: "mid",
    label: "中等水平的一篇",
    hint: "预期 8 分档左右",
    topic:
      "Suppose you are a student who wants to join a volunteer program. Write a letter to the program organizer to apply for it. You should write at least 120 words.",
    text: `Dear Sir or Madam,

I am writing to apply for the volunteer program which was advertised on the notice board of our university last week. I am a sophomore from the English Department, and I am very interested in this program.

There are several reasons why I think I am suitable for this job. First of all, I have enough time because my courses are not very heavy this term. I can work on weekends and also during the summer holiday. Moreover, I have some relevant experience. Last summer, I took part in a activity which helped the old people in the community. I helped them to clean their rooms and talked with them. From this experience, I learned how to communicate with different people, and I became more patient.

In addition, I am a person who is easy to get along with. I like working with others and I am not afraid of difficulties. Although my English is not perfect, I am willing to learn and I can improve it quickly.

I would be very grateful if you could give me this opportunity. I am looking forward to your reply.

Yours sincerely,
Li Ming`,
  },
  {
    id: "good",
    label: "写得较好的一篇",
    hint: "预期 11 分档或以上",
    topic:
      "Suppose you are a student who wants to join a volunteer program. Write a letter to the program organizer to apply for it. You should write at least 120 words.",
    text: `Dear Sir or Madam,

I am writing to express my keen interest in the volunteer program advertised on the university notice board last week. As a sophomore majoring in English, I believe I am well positioned to contribute to your team.

My suitability for this role rests on three things. The first is availability. My course load this term is relatively light, which means I can commit to a regular weekend schedule and to the full summer session without conflicting with my studies. The second is relevant experience. Last summer I volunteered at a community centre for the elderly, where I helped with daily chores and, more importantly, spent time talking with residents who rarely had visitors. That experience taught me that effective volunteering depends less on enthusiasm than on reliability and patience. The third is temperament. I work well in teams, I am comfortable with people of different backgrounds, and I do not lose heart when a task turns out to be harder than expected.

I am aware that my spoken English still has room for improvement, so I have been practising with a language partner twice a week since March. I am confident that this will not prevent me from carrying out the duties you assign.

I would welcome the chance to discuss my application further, and I can be reached at 138xxxx at any time. Thank you for your consideration.

Yours sincerely,
Li Ming`,
  },
];
