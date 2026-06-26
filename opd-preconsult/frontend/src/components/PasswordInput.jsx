'use client';
import { useState } from 'react';

// A password input with a Show/Hide toggle. Forwards all standard <input> props
// (className, value, onChange, placeholder, maxLength, inputMode, required, style…).
export default function PasswordInput({ style, toggleStyle, ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        {...props}
        type={show ? 'text' : 'password'}
        style={{ ...style, paddingRight: 56 }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer', padding: 4,
          fontSize: 13, fontWeight: 600, color: 'var(--secondary)', lineHeight: 1,
          ...toggleStyle,
        }}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
