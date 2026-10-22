import { sanitizeCode, CODE_LENGTH } from './two-step';

// The one field a 6-digit code from an authenticator app is typed into: at
// sign-in, when 2-step sign-in is set up or turned off, and in "Confirm it's
// you". One box rather than six, so a paste and the phone's own "fill the
// code" suggestion (autoComplete one-time-code) both work, with the number
// pad on a phone (inputMode numeric). Only digits are kept (two-step.js
// sanitizeCode). A paste is read whole before maxLength can cut it: an app
// copies "123 456", seven characters, and the box would have kept "123 45".
export default function CodeInput({ id, value, onChange, className = 'form-input', style, ...rest }) {
  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={CODE_LENGTH}
      className={className}
      placeholder="123456"
      spellCheck={false}
      autoCorrect="off"
      value={value}
      onChange={e => onChange(sanitizeCode(e.target.value))}
      onPaste={e => {
        const text = e.clipboardData?.getData('text');
        if (typeof text !== 'string') return;
        e.preventDefault();
        const digits = sanitizeCode(text);
        if (digits) onChange(digits);
      }}
      style={{ fontFamily: 'monospace', fontSize: 18, letterSpacing: '0.3em', ...style }}
      {...rest}
    />
  );
}
