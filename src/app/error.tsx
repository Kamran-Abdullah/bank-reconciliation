'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application error:', error);
  }, [error]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '2rem',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem', color: '#dc2626' }}>
        Something went wrong!
      </h1>
      <p style={{ marginBottom: '1rem', color: '#666', textAlign: 'center', maxWidth: '500px' }}>
        {error.message || 'An unexpected error occurred while processing your request.'}
      </p>
      <button
        onClick={reset}
        style={{
          padding: '0.75rem 1.5rem',
          backgroundColor: '#2563eb',
          color: 'white',
          border: 'none',
          borderRadius: '0.5rem',
          cursor: 'pointer',
          fontSize: '1rem',
        }}
      >
        Try Again
      </button>
    </div>
  );
}
