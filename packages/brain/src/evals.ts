import type { Intent } from "./classify";

/** Synthetic evaluation set for signal triage. Every correction from the UI should be appended here as a new case. */
export interface TriageCase { id: string; text: string; expected: Intent; note?: string }

export const TRIAGE_EVAL: TriageCase[] = [
  { id: "t01", text: "Would you be free for a call on Thursday?", expected: "meeting_request" },
  { id: "t02", text: "Can we schedule a zoom to discuss?", expected: "meeting_request" },
  { id: "t03", text: "Ευχαριστώ, θα ήθελα ένα ραντεβού την επόμενη εβδομάδα", expected: "meeting_request" },
  { id: "t04", text: "What would this cost for a team of ten?", expected: "pricing_question" },
  { id: "t05", text: "Could you send a quote?", expected: "pricing_question", note: "quote beats generic question" },
  { id: "t06", text: "Not right now, maybe next quarter.", expected: "not_now" },
  { id: "t07", text: "No thanks, we are all set", expected: "decline" },
  { id: "t08", text: "Please unsubscribe me from your list", expected: "unsubscribe" },
  { id: "t09", text: "I am out of office until Monday. This is an automatic reply.", expected: "out_of_office" },
  { id: "t10", text: "I would like to introduce you to Maria from Acme", expected: "introduction" },
  { id: "t11", text: "Sounds interesting, tell me more", expected: "interested" },
  { id: "t12", text: "How does the onboarding work?", expected: "question" },
  { id: "t13", text: "Thanks.", expected: "unknown" },
  { id: "t14", text: "We already have a vendor for this, not interested.", expected: "decline" },
  { id: "t15", text: "Δεν ενδιαφερόμαστε, ευχαριστούμε", expected: "decline" },
];
