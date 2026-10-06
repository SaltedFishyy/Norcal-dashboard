const levels = new Map([
  ['S级 极难', 'S'], ['A级 难', 'A'], ['B级 中', 'B'], ['C级 易', 'C'], ['D级 极易', 'D'],
]);

export const DIFFICULTY_COLORS = Object.freeze({
  S: '#7e22ce', A: '#dc2626', B: '#eab308', C: '#15803d', D: '#86efac',
  unknown: '#9ca3af',
});

export const difficultyLevel = text => typeof text === 'string' ? levels.get(text.trim()) ?? null : null;
export const difficultyColor = level => Object.hasOwn(DIFFICULTY_COLORS, level)
  ? DIFFICULTY_COLORS[level] : DIFFICULTY_COLORS.unknown;
