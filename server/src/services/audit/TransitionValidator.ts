export interface TransitionValidationInput {
  opening: string;
}

export interface TransitionValidationResult {
  valid: boolean;
  transitionType: "scene-continuation" | "time-shift" | "location-shift" | "missing-transition";
  marker: string | null;
}

const EXPLICIT_RESET_REGEX = /^(次日|翌日|第二天|几天后|数日后|当天|当晚|清晨|凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|与此同时|另一边|另一头|回到|再回到)/;
const TIME_SHIFT_REGEX = /^(次日|翌日|第二天|几天后|数日后|当天|当晚|清晨|凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|十分钟后|半小时后|一小时后|随后|接着)/;
const LOCATION_SHIFT_REGEX = /^(来到|离开|回到|返回|折返|出了|走进|进入|赶到|到了)/;
const CONTINUATION_REGEX = /(还在|仍在|继续|接着|随后|带着|记着|想着|顺着|沿着|刚刚|刚才)/;

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function validateTransition(input: TransitionValidationInput): TransitionValidationResult {
  const opening = normalizeText(input.opening);
  if (!opening) {
    return {
      valid: true,
      transitionType: "scene-continuation",
      marker: null,
    };
  }
  const timeShift = TIME_SHIFT_REGEX.exec(opening);
  if (timeShift) {
    return {
      valid: true,
      transitionType: "time-shift",
      marker: timeShift[0],
    };
  }
  const locationShift = LOCATION_SHIFT_REGEX.exec(opening);
  if (locationShift) {
    return {
      valid: true,
      transitionType: "location-shift",
      marker: locationShift[0],
    };
  }
  if (!EXPLICIT_RESET_REGEX.test(opening) || CONTINUATION_REGEX.test(opening)) {
    return {
      valid: true,
      transitionType: "scene-continuation",
      marker: CONTINUATION_REGEX.exec(opening)?.[0] ?? null,
    };
  }
  return {
    valid: false,
    transitionType: "missing-transition",
    marker: null,
  };
}
