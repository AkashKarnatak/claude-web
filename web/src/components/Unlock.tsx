// Access-token gate, shown when the server is bound to a non-loopback
// address. The token is remembered per device (localStorage).

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { submitToken } from '../ws';

export function Unlock() {
  const [token, setToken] = useState('');
  const failed = useStore((s) => s.authState === 'failed');

  // A rejected token shouldn't linger in the field.
  useEffect(() => {
    if (failed) setToken('');
  }, [failed]);

  const submit = () => {
    const trimmed = token.trim();
    if (trimmed) submitToken(trimmed);
  };

  return (
    <div className="unlock">
      <div className="unlock-card">
        <h2>claude web</h2>
        <p className="unlock-hint">
          This server requires an access token
          {failed && <span className="unlock-error"> — that token was rejected, try again</span>}
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Access token"
          autoFocus
          autoComplete="current-password"
        />
        <button className="btn allow" onClick={submit} disabled={!token.trim()}>
          Unlock
        </button>
        <p className="unlock-hint dim">
          The token is in the server's <code>AUTH_TOKEN</code> env or <code>data/auth-token</code>.
        </p>
      </div>
    </div>
  );
}
