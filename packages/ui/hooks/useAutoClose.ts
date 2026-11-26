import { useState, useEffect } from 'react';

const AUTO_CLOSE_SECONDS = 3;

/**
 * Phases of the auto-close lifecycle after a form submission.
 *
 * - idle:        nothing submitted yet
 * - counting:    countdown is ticking (seconds remaining in `remaining`)
 * - requested:   the close request was sent
 * - closeFailed: window.close() was blocked by the browser
 */
type AutoClosePhase =
  | { phase: 'idle' }
  | { phase: 'counting'; remaining: number }
  | { phase: 'requested' }
  | { phase: 'closeFailed' };

type GlimpseWindow = Window & {
  glimpse?: {
    close?: () => void;
  };
};

function requestGlimpseClose(): boolean {
  const glimpseClose = (window as GlimpseWindow).glimpse?.close;
  if (typeof glimpseClose === 'function') {
    glimpseClose();
    return true;
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ __plannotator_glimpse_close: true }, '*');
    return true;
  }

  return false;
}

function tryClose(onFail: () => void): ReturnType<typeof setTimeout> | undefined {
  const requestedNativeClose = requestGlimpseClose();
  if (requestedNativeClose) {
    return;
  }

  window.close();
  // window.close() is silently ignored when the tab wasn't opened by script.
  // Check after a short delay whether we're still alive.
  return setTimeout(() => {
    if (!window.closed) onFail();
  }, 300);
}

/**
 * Manages the auto-close countdown that runs after a submission overlay appears.
 *
 * @param active - pass `true` once the overlay should appear (i.e. form was submitted)
 */
export function useAutoClose(active: boolean): AutoClosePhase {
  const [state, setState] = useState<AutoClosePhase>({ phase: 'idle' });

  useEffect(() => {
    if (!active) return;

    let remaining = AUTO_CLOSE_SECONDS;
    setState({ phase: 'counting', remaining });
    const countdown = setInterval(() => {
      if (--remaining > 0) setState({ phase: 'counting', remaining });
    }, 1000);
    let closeCheck: ReturnType<typeof setTimeout> | undefined;
    // Schedule the close independently of countdown renders.
    const close = setTimeout(() => {
      clearInterval(countdown);
      setState({ phase: 'requested' });
      closeCheck = tryClose(() => setState({ phase: 'closeFailed' }));
    }, AUTO_CLOSE_SECONDS * 1000);

    return () => {
      clearInterval(countdown);
      clearTimeout(close);
      clearTimeout(closeCheck);
    };
  }, [active]);

  return state;
}
