export function examplesEnabled(
  value = import.meta.env.VITE_SHOW_EXAMPLES as string | undefined,
) {
  return value !== "false";
}

export const showExamples = examplesEnabled();
