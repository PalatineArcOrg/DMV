// Minimal `react-native` stub for the browser. The only thing the reused core
// (`utils/constants.ts`) imports from RN is `Platform`, and only for a font
// family via `Platform.select`. Everything else in the claim closure is pure JS.
type SelectMap<T> = { web?: T; ios?: T; android?: T; native?: T; default?: T };

export const Platform = {
  OS: 'web' as const,
  select<T>(map: SelectMap<T>): T | undefined {
    return map.web ?? map.default ?? map.native;
  },
};
