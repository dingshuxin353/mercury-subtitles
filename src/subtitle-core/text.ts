export function countSubtitleCharacters(value: string): number {
  return value.match(/\p{Script=Han}|\p{N}|[A-Za-z]+/gu)?.length ?? 0;
}

export function lineCount(value: string): number {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').length;
}
