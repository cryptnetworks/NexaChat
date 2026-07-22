import type { ReactNode } from 'react';
import type { ThemePreference } from './theme.js';
export function ThemeControls(props: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}): ReactNode {
  return (
    <fieldset>
      <legend>Color theme</legend>
      {(['system', 'light', 'dark'] as const).map((value) => (
        <label key={value}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={props.value === value}
            onChange={() => {
              props.onChange(value);
            }}
          />
          {value === 'system'
            ? 'Use system setting'
            : value === 'light'
              ? 'Light'
              : 'Dark'}
        </label>
      ))}
    </fieldset>
  );
}
