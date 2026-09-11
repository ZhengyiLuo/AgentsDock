const PATCH_CHANGE_SIGNAL = /diff --git |\*\*\* (?:begin patch|update file:|add file:|delete file:)/i

export function hasTimelineChangeSignal(value: string): boolean {
  return PATCH_CHANGE_SIGNAL.test(value) || /^---\s/m.test(value) && /^\+\+\+\s/m.test(value) ||
    /^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+\S+/m.test(value)
}
