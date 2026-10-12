import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ContextUnavailableError,
  closeWebview,
  isEmbedded,
  loadWebviewSdk,
  requestContextToken,
} from './webviewSdk';
import { confirmProductOnServer, verifyContext } from './api';

/**
 * phase:
 *  - 'checking'   waiting for the SDK / first context check
 *  - 'standalone' opened outside Zendesk: never submit anything
 *  - 'ready'      opened from a conversation and the context was verified
 *  - 'unavailable' opened inside Zendesk but no valid context (see contextMessage)
 *
 * submitState: 'idle' | 'submitting' | 'success' | 'error'
 */

const CONTEXT_MESSAGE =
  "We couldn't connect this page to your chat, so your result can't be sent yet. " +
  'Please close this window and open the product finder again from the chat.';

function messageForError(error) {
  if (error instanceof ContextUnavailableError) return CONTEXT_MESSAGE;
  switch (error && error.code) {
    case 'network':
      return "We couldn't reach the server. Check your connection and try again.";
    case 'token_expired':
    case 'invalid_token':
    case 'invalid_claims':
    case 'untrusted_subdomain':
    case 'untrusted_app':
    case 'untrusted_integration':
      return (
        "We couldn't verify your chat session. Please try again. If it keeps failing, " +
        'close this window and open the product finder again from the chat.'
      );
    case 'conversation_not_found':
      return "We couldn't find your chat conversation. Please open the product finder again from the chat.";
    case 'zendesk_error':
    case 'zendesk_unreachable':
      return "We couldn't deliver your result to the chat. Your product is still shown here. Please try again.";
    default:
      return 'Something went wrong while sending your result. Your product is still shown here. Please try again.';
  }
}

export function useZendeskConversation() {
  const [phase, setPhase] = useState('checking');
  const [contextMessage, setContextMessage] = useState('');
  const [submitState, setSubmitState] = useState('idle');
  const [submitError, setSubmitError] = useState('');
  const [closed, setClosed] = useState(false);

  const sdkRef = useRef(null);
  // Synchronous guard: state updates are async, a fast double click is not.
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const sdk = await loadWebviewSdk();
      if (cancelled) return;
      sdkRef.current = sdk;

      if (!isEmbedded(sdk)) {
        setPhase('standalone');
        return;
      }

      try {
        const token = await requestContextToken(sdk);
        await verifyContext(token);
        if (!cancelled) setPhase('ready');
      } catch (error) {
        console.warn('[zendesk] conversation context unavailable:', error);
        if (cancelled) return;
        setContextMessage(error && error.code === 'network' ? messageForError(error) : CONTEXT_MESSAGE);
        setPhase('unavailable');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Sends the identified product to the conversation. `submissionId` must stay
   * the same for every retry of the same result so the server can de-duplicate.
   */
  const confirmProduct = useCallback(async (productName, submissionId) => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSubmitState('submitting');
    setSubmitError('');

    try {
      // Tokens are short lived: always ask for a fresh one right before sending.
      const token = await requestContextToken(sdkRef.current);
      await confirmProductOnServer({ token, productName, submissionId });

      setPhase('ready');
      setContextMessage('');
      setSubmitState('success');
      // Only now is it true that the result reached the conversation.
      const didClose = await closeWebview(sdkRef.current);
      setClosed(didClose);
      return true;
    } catch (error) {
      console.warn('[zendesk] could not confirm product:', error);
      setSubmitError(messageForError(error));
      setSubmitState('error');
      return false;
    } finally {
      submittingRef.current = false;
    }
  }, []);

  /** Forget a previous attempt (new result / start over). */
  const resetSubmission = useCallback(() => {
    if (submittingRef.current) return;
    setSubmitState('idle');
    setSubmitError('');
    setClosed(false);
  }, []);

  return {
    phase,
    contextMessage,
    submitState,
    submitError,
    closed,
    confirmProduct,
    resetSubmission,
  };
}

export function createSubmissionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
