import { Router } from 'express';
import {
  deleteMessage,
  getConversation,
  getMentors,
  getMessages,
  getRoundCandidates,
  countOpenRoundChoices,
  getDiscardedCandidates,
  insertCandidate,
  insertUserMessage,
  selectCandidate,
  unselectCandidate,
  dismissPendingCandidates,
} from '../db.js';
import { conversationLog } from '../debug.js';
import { buildSystemPrompt, buildRoomTranscript, chatCompletion } from '../openrouter.js';

const router = Router({ mergeParams: true });

/** In-process lock so concurrent POST /turns can't bypass the pending guard. */
const turnsInFlight = new Set();

router.post('/turns', async (req, res) => {
  const conversationId = Number(req.params.id);
  try {
    const conversation = getConversation(conversationId);
    if (!conversation) {
      conversationLog(conversationId, 'turn.rejected', {
        reason: 'not_found',
      });
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const content = String(req.body?.content || '').trim();
    if (!content) {
      conversationLog(conversationId, 'turn.rejected', {
        reason: 'empty_content',
      });
      return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    }

    if (turnsInFlight.has(conversationId)) {
      conversationLog(conversationId, 'turn.rejected', {
        reason: 'turn_in_flight',
      });
      return res.status(409).json({
        error:
          'Ya hay un turno en curso en esta sala. Espera a que terminen los mentores.',
      });
    }

    const openChoices = countOpenRoundChoices(conversationId);
    const existingRound = getRoundCandidates(conversationId);
    if (openChoices > 0) {
      conversationLog(conversationId, 'turn.rejected', {
        reason: 'open_round',
        openChoices,
      });
      return res.status(409).json({
        error:
          'Hay opiniones por revisar. Elige las que quieras o pulsa Continuar sin elegir más.',
        roundCandidates: existingRound,
        pendingCandidates: existingRound.filter(
          (c) => c.status === 'pending' || c.status === 'rejected'
        ),
      });
    }

    const mentors = getMentors(conversationId);
    if (mentors.length === 0) {
      conversationLog(conversationId, 'turn.rejected', {
        reason: 'no_mentors',
      });
      return res
        .status(400)
        .json({ error: 'Agrega al menos un mentor a la sala' });
    }

    turnsInFlight.add(conversationId);

    let userMessage;
    try {
      userMessage = insertUserMessage(conversationId, content);
      const history = getMessages(conversationId);

      conversationLog(conversationId, 'turn.started', {
        userMessageId: userMessage.id,
        content,
        mentorCount: mentors.length,
        mentors: mentors.map((m) => ({
          id: m.id,
          name: m.name,
          model_id: m.model_id,
        })),
        historyLength: history.length,
        language: conversation.language,
      });

      const results = await Promise.allSettled(
        mentors.map((mentor) => {
          const system = buildSystemPrompt({
            mentorName: mentor.name,
            language: conversation.language,
          });
          const transcript = buildRoomTranscript(history);
          conversationLog(conversationId, 'mentor.request', {
            mentorId: mentor.id,
            mentorName: mentor.name,
            modelId: mentor.model_id,
            userMessageId: userMessage.id,
            system,
            transcript,
          });
          const started = Date.now();
          return chatCompletion({
            model: mentor.model_id,
            mentorName: mentor.name,
            language: conversation.language,
            messages: history,
          }).then((text) => {
            conversationLog(conversationId, 'mentor.response', {
              mentorId: mentor.id,
              mentorName: mentor.name,
              modelId: mentor.model_id,
              ms: Date.now() - started,
              chars: text.length,
              content: text,
            });
            return { mentor, text };
          });
        })
      );

      const candidates = [];
      const errors = [];

      results.forEach((result, index) => {
        const mentor = mentors[index];
        if (result.status === 'fulfilled') {
          const candidate = insertCandidate({
            conversationId,
            userMessageId: userMessage.id,
            mentorId: mentor.id,
            content: result.value.text,
          });
          candidates.push(candidate);
          conversationLog(conversationId, 'candidate.created', {
            candidateId: candidate.id,
            mentorId: mentor.id,
            mentorName: mentor.name,
            modelId: mentor.model_id,
          });
        } else {
          const error = result.reason?.message || String(result.reason);
          errors.push({
            mentor_id: mentor.id,
            mentor_name: mentor.name,
            model_id: mentor.model_id,
            error,
          });
          conversationLog(conversationId, 'mentor.error', {
            mentorId: mentor.id,
            mentorName: mentor.name,
            modelId: mentor.model_id,
            error,
          });
        }
      });

      if (candidates.length === 0) {
        deleteMessage(userMessage.id, conversationId);
        conversationLog(conversationId, 'turn.rolled_back', {
          userMessageId: userMessage.id,
          reason: 'all_mentors_failed',
          errors,
        });
        return res.status(502).json({
          error:
            'Ningún mentor respondió. Tu mensaje no se guardó; puedes reintentar.',
          errors,
        });
      }

      conversationLog(conversationId, 'turn.completed', {
        userMessageId: userMessage.id,
        candidateCount: candidates.length,
        errorCount: errors.length,
      });

      res.json({
        userMessage,
        candidates,
        roundCandidates: getRoundCandidates(conversationId),
        errors,
      });
    } finally {
      turnsInFlight.delete(conversationId);
    }
  } catch (err) {
    turnsInFlight.delete(conversationId);
    conversationLog(conversationId, 'turn.error', {
      error: err.message,
      status: err.status || 500,
    });
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/select', (req, res) => {
  const conversationId = Number(req.params.id);
  try {
    const conversation = getConversation(conversationId);
    if (!conversation) {
      conversationLog(conversationId, 'select.rejected', {
        reason: 'not_found',
      });
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const candidateId = Number(req.body?.candidate_id);
    if (!candidateId) {
      conversationLog(conversationId, 'select.rejected', {
        reason: 'missing_candidate_id',
      });
      return res.status(400).json({ error: 'candidate_id es obligatorio' });
    }

    conversationLog(conversationId, 'select.requested', { candidateId });

    const result = selectCandidate(candidateId, conversationId);
    if (!result) {
      conversationLog(conversationId, 'select.rejected', {
        reason: 'candidate_not_found',
        candidateId,
      });
      return res.status(404).json({ error: 'Candidata no encontrada' });
    }

    conversationLog(conversationId, 'select.committed', {
      candidateId: result.candidate.id,
      mentorId: result.candidate.mentor_id,
      mentorName: result.candidate.mentor_name,
      messageId: result.message.id,
      content: result.message.content,
      remainingPending: result.roundCandidates.filter(
        (c) => c.status === 'pending' || c.status === 'rejected'
      ).length,
    });

    res.json({
      message: result.message,
      candidate: result.candidate,
      messages: getMessages(conversationId),
      roundCandidates: result.roundCandidates,
      pendingCandidates: result.roundCandidates.filter(
        (c) => c.status === 'pending' || c.status === 'rejected'
      ),
      discardedCandidates: getDiscardedCandidates(conversationId),
    });
  } catch (err) {
    conversationLog(conversationId, 'select.error', { error: err.message });
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/unselect', (req, res) => {
  const conversationId = Number(req.params.id);
  try {
    const conversation = getConversation(conversationId);
    if (!conversation) {
      conversationLog(conversationId, 'unselect.rejected', {
        reason: 'not_found',
      });
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const candidateId = Number(req.body?.candidate_id);
    if (!candidateId) {
      conversationLog(conversationId, 'unselect.rejected', {
        reason: 'missing_candidate_id',
      });
      return res.status(400).json({ error: 'candidate_id es obligatorio' });
    }

    conversationLog(conversationId, 'unselect.requested', { candidateId });

    const result = unselectCandidate(candidateId, conversationId);
    if (!result) {
      conversationLog(conversationId, 'unselect.rejected', {
        reason: 'candidate_not_found',
        candidateId,
      });
      return res.status(404).json({ error: 'Candidata no encontrada' });
    }

    conversationLog(conversationId, 'unselect.committed', {
      candidateId: result.candidate.id,
      mentorId: result.candidate.mentor_id,
      mentorName: result.candidate.mentor_name,
    });

    res.json({
      candidate: result.candidate,
      messages: result.messages,
      roundCandidates: result.roundCandidates,
      pendingCandidates: result.roundCandidates.filter(
        (c) => c.status === 'pending' || c.status === 'rejected'
      ),
      discardedCandidates: getDiscardedCandidates(conversationId),
    });
  } catch (err) {
    conversationLog(conversationId, 'unselect.error', { error: err.message });
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/dismiss', (req, res) => {
  const conversationId = Number(req.params.id);
  try {
    const conversation = getConversation(conversationId);
    if (!conversation) {
      conversationLog(conversationId, 'dismiss.rejected', {
        reason: 'not_found',
      });
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const result = dismissPendingCandidates(conversationId);
    conversationLog(conversationId, 'dismiss.completed', {
      rejected: result.rejected,
      userMessageId: result.dismissedFromUserMessageId ?? null,
    });

    res.json({
      rejected: result.rejected,
      roundCandidates: [],
      pendingCandidates: [],
      discardedCandidates: getDiscardedCandidates(conversationId),
      messages: getMessages(conversationId),
    });
  } catch (err) {
    conversationLog(conversationId, 'dismiss.error', { error: err.message });
    res.status(err.status || 400).json({ error: err.message });
  }
});

export default router;
