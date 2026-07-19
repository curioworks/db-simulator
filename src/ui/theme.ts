import { useEffect, useState } from 'react';

/** Chart chrome + series tokens (reference dataviz palette, both modes validated). */
export interface Theme {
  surface: string;
  page: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  series1: string;
  series2: string;
  series3: string;
  series4: string;
  series5: string;
  border: string;
}

export const lightTheme: Theme = {
  surface: '#fcfcfb',
  page: '#f9f9f7',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  series1: '#2a78d6',
  series2: '#008300',
  series3: '#e87ba4',
  series4: '#eda100',
  series5: '#1baf7a',
  border: 'rgba(11,11,11,0.10)',
};

export const darkTheme: Theme = {
  surface: '#1a1a19',
  page: '#0d0d0d',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  series1: '#3987e5',
  series2: '#008300',
  series3: '#d55181',
  series4: '#c98500',
  series5: '#199e70',
  border: 'rgba(255,255,255,0.10)',
};

/** Recharts takes colors as JS values, so theme choice lives in JS too. */
export function useTheme(): Theme {
  const [dark, setDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark ? darkTheme : lightTheme;
}
