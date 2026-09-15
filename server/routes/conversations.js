import { Router } from 'express';
import {
  createConversation,
  deleteConversation,
  getConversation,
  getMentors,
  getMessages,
  listConversations,
  replaceMentors,
  updateConversation,
  updateMentorName,
  getRoundCandidates,
  countOpenRoundChoices,
  getDiscardedCandidates,
} from '../db.js';
import { conversationLog, debugLog } from '../debug.js';
import { listModels } from '../openrouter.js';

const router = Router();

router.get('/', (_req, res) => {
  const conversations = listConversations();
  debugLog('conversations.list', { count: conversations.length });
  res.json({ conversations });
});

router.post('/', (req, res) => {
  const { title, language } = req.body || {};
  const conversation = createConversation({ title, language });
  conversationLog(conversation.id, 'conversation.created', {
    title: conversation.title,
    language: conversation.language,
  });
  res.status(201).json({ conversation });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const conversation = getConversation(id);
  if (!conversation) {
    conversationLog(id, 'conversation.get', { found: false });
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const mentors = getMentors(id);
  const messages = getMessages(id);
  const roundCandidates = getRoundCandidates(id);
  const pendingCandidates = roundCandidates.filter(
    (c) => c.status === 'pending' || c.status === 'rejected'
  );
  const discardedCandidates = getDiscardedCandidates(id);
  conversationLog(id, 'conversation.get', {
    found: true,
    mentorCount: mentors.length,
    messageCount: messages.length,
    pendingCount: pendingCandidates.length,
    roundCount: roundCandidates.length,
    discardedCount: discardedCandidates.length,
  });
  res.json({
    conversation,
    mentors,
    messages,
    roundCandidates,
    pendingCandidates,
    discardedCandidates,
  });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const conversation = updateConversation(id, req.body || {});
  if (!conversation) {
    conversationLog(id, 'conversation.update', { found: false });
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  conversationLog(id, 'conversation.updated', {
    title: conversation.title,
    language: conversation.language,
  });
  res.json({ conversation });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = deleteConversation(id);
  if (result.changes === 0) {
    conversationLog(id, 'conversation.delete', { found: false });
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  conversationLog(id, 'conversation.deleted', {});
  res.json({ ok: true });
});

router.put('/:id/mentors', (req, res) => {
  const id = Number(req.params.id);
  const conversation = getConversation(id);
  if (!conversation) {
    conversationLog(id, 'mentors.replace', { found: false });
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const openChoices = countOpenRoundChoices(id);
  if (openChoices > 0) {
    conversationLog(id, 'mentors.replace', {
      rejected: 'open_round',
      openChoices,
    });
    return res.status(409).json({
      error:
        'Hay opiniones por revisar. Elige las que quieras o Continuar antes de cambiar mentores.',
      roundCandidates: getRoundCandidates(id),
    });
  }
  const mentorsInput = Array.isArray(req.body?.mentors) ? req.body.mentors : [];
  if (mentorsInput.length === 0) {
    conversationLog(id, 'mentors.replace', { rejected: 'empty' });
    return res.status(400).json({ error: 'Selecciona al menos un mentor' });
  }
  for (const m of mentorsInput) {
    if (!m?.model_id) {
      conversationLog(id, 'mentors.replace', { rejected: 'missing_model_id' });
      return res.status(400).json({ error: 'Cada mentor necesita model_id' });
    }
  }
  const mentors = replaceMentors(id, mentorsInput);
  conversationLog(id, 'mentors.replaced', {
    mentors: mentors.map((m) => ({
      id: m.id,
      name: m.name,
      model_id: m.model_id,
    })),
  });
  res.json({ mentors });
});

router.patch('/:id/mentors/:mentorId', (req, res) => {
  const conversationId = Number(req.params.id);
  const mentorId = Number(req.params.mentorId);
  const conversation = getConversation(conversationId);
  if (!conversation) {
    conversationLog(conversationId, 'mentor.rename', { found: false });
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    conversationLog(conversationId, 'mentor.rename', {
      rejected: 'empty_name',
      mentorId,
    });
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }
  const mentor = updateMentorName(mentorId, conversationId, name);
  if (!mentor) {
    conversationLog(conversationId, 'mentor.rename', {
      found: false,
      mentorId,
    });
    return res.status(404).json({ error: 'Mentor no encontrado' });
  }
  conversationLog(conversationId, 'mentor.renamed', {
    mentorId: mentor.id,
    name: mentor.name,
    model_id: mentor.model_id,
  });
  res.json({ mentor });
});

export default router;

export async function modelsHandler(req, res) {
  try {
    const q = req.query.q || '';
    const models = await listModels(q);
    debugLog('models.list', { query: q, count: models.length });
    res.json({ models });
  } catch (err) {
    debugLog('models.list.error', {
      error: err.message,
      status: err.status || 500,
    });
    res.status(err.status || 500).json({ error: err.message });
  }
}
