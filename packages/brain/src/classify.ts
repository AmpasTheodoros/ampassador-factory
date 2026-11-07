import type { ActionClass } from "@aaf/core";

export type Intent =
  | "meeting_request"
  | "pricing_question"
  | "interested"
  | "not_now"
  | "decline"
  | "out_of_office"
  | "unsubscribe"
  | "introduction"
  | "question"
  | "unknown";

export interface IntentRule {
  intent: Intent;
  pattern: RegExp;
  actionClass: ActionClass;
  urgency: number; // 0-10
  impact: number; // 0-10
  effort: number; // 0-10
  confidence: number; // 0-1
  needsReply: boolean;
  label: string;
}

/** Ordered: first match wins. Greek keywords included for the user's market. */
export const INTENT_RULES: IntentRule[] = [
  {
    intent: "unsubscribe",
    pattern: /\b(unsubscribe|remove me|stop (emailing|contacting)|do not contact)\b|διαγραφ[ήη] από|μην (μου )?στείλ/i,
    actionClass: "ignore",
    urgency: 3,
    impact: 1,
    effort: 1,
    confidence: 0.9,
    needsReply: false,
    label: "Opt-out request: honour it, do not reply",
  },
  {
    intent: "out_of_office",
    pattern: /\b(out of (the )?office|automatic reply|auto-?reply|on (annual )?leave|vacation until)\b|εκτός γραφείου/i,
    actionClass: "monitor",
    urgency: 1,
    impact: 1,
    effort: 1,
    confidence: 0.9,
    needsReply: false,
    label: "Auto-reply: no action, revisit after return date",
  },
  {
    intent: "decline",
    pattern: /\b(not interested|no thanks|no,? thank you|we(')?re all set|already have (a|an) )\b|δεν ενδιαφερόμαστε|όχι ευχαριστώ/i,
    actionClass: "monitor",
    urgency: 1,
    impact: 2,
    effort: 1,
    confidence: 0.8,
    needsReply: false,
    label: "Declined: do not chase",
  },
  {
    intent: "not_now",
    pattern:
      /\b(not (right )?now|maybe (later|next)|reach out (again )?in|circle back|next quarter|bad timing|too busy)\b|όχι τώρα|αργότερα|του χρόνου/i,
    actionClass: "schedule",
    urgency: 2,
    impact: 5,
    effort: 2,
    confidence: 0.75,
    needsReply: true,
    label: "Soft no / timing: short thanks, schedule a single later check-in",
  },
  {
    intent: "meeting_request",
    pattern: /\b(call|meet(ing)?|catch up|coffee|zoom|schedule|available (on|next|this)|demo|chat)\b|συνάντηση|ραντεβού|κλήση|τηλέφων/i,
    actionClass: "act_now",
    urgency: 8,
    impact: 8,
    effort: 3,
    confidence: 0.75,
    needsReply: true,
    label: "Wants a conversation: highest-value reply",
  },
  {
    intent: "pricing_question",
    pattern: /\b(pric(e|ing)|cost|how much|quote|proposal|budget|fees?|rates?)\b|τιμή|κόστος|προσφορά|πόσο/i,
    actionClass: "act_now",
    urgency: 8,
    impact: 8,
    effort: 4,
    confidence: 0.75,
    needsReply: true,
    label: "Commercial question: buying signal, scope before price",
  },
  {
    intent: "introduction",
    pattern: /\b(introduc(e|ing|tion)|meet my|connect you (with|to)|loop(ing)? in|cc'?ing)\b|σας συστήνω|συστήσω/i,
    actionClass: "act_now",
    urgency: 7,
    impact: 7,
    effort: 2,
    confidence: 0.7,
    needsReply: true,
    label: "Introduction: respond quickly and thank the introducer",
  },
  {
    intent: "interested",
    pattern:
      /\b(interested|sounds (good|great|interesting)|tell me more|love to (hear|learn)|would like to (know|learn|hear))\b|ενδιαφέρ|ακούγεται (καλά|ενδιαφέρον)|πείτε μου περισσότερα/i,
    actionClass: "act_now",
    urgency: 7,
    impact: 7,
    effort: 3,
    confidence: 0.7,
    needsReply: true,
    label: "Warm interest: deepen with a specific question",
  },
  {
    intent: "question",
    pattern: /\?|\b(could you|can you|do you|how (do|does|can)|what (is|are)|why)\b|μπορ(είτε|εί)|πώς/i,
    actionClass: "follow_up",
    urgency: 5,
    impact: 5,
    effort: 3,
    confidence: 0.5,
    needsReply: true,
    label: "Question: answer and clarify the underlying need",
  },
];

export const UNKNOWN_RULE: IntentRule = {
  intent: "unknown",
  pattern: /$^/,
  actionClass: "follow_up",
  urgency: 3,
  impact: 3,
  effort: 3,
  confidence: 0.3,
  needsReply: true,
  label: "Unclear intent: low confidence, human reads it first",
};

const INJECTION =
  /(ignore (all |any )?(previous|prior|above) (instructions|prompts?)|disregard (the )?(system|previous)|you are now|new instructions:|system prompt|reveal (your|the) (prompt|instructions|secrets?|api key)|forward (all|every).{0,30}(contacts|emails)|send .{0,40}to [\w.+-]+@[\w.-]+)/i;

export interface Classification {
  rule: IntentRule;
  matched: string | null;
  injectionSuspected: boolean;
  score: number;
}

export const priorityScore = (r: { impact: number; urgency: number; confidence: number; effort: number }) =>
  Math.round(((r.impact * r.urgency * r.confidence) / (1 + r.effort / 10)) * 10) / 10;

/** Pure function over untrusted text: its only output is data. It cannot trigger tools. */
export function classify(text: string, rules: IntentRule[] = INTENT_RULES): Classification {
  const injectionSuspected = INJECTION.test(text);
  for (const rule of rules) {
    const m = text.match(rule.pattern);
    if (m) return { rule, matched: m[0], injectionSuspected, score: priorityScore(rule) };
  }
  return { rule: UNKNOWN_RULE, matched: null, injectionSuspected, score: priorityScore(UNKNOWN_RULE) };
}
