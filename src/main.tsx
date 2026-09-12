/**
 * Browser entry point for the React application.
 *
 * Keeping bootstrap code isolated from `App` makes the UI shell easier to test
 * and keeps environment-specific concerns, such as StrictMode mounting, out of
 * the application state coordinator.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyEmbedClass } from './embedMode';

applyEmbedClass();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
