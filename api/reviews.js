import { kv } from '@vercel/kv';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function sanitize(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').trim();
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'list';
  const id = url.searchParams.get('id') || '';

  try {
    // GET /api/reviews — список отзывов
    if (req.method === 'GET') {
      const reviews = (await kv.get('all_reviews')) || [];
      const total = reviews.length;
      const avgRating = total > 0
        ? parseFloat((reviews.reduce((s, r) => s + r.rating, 0) / total).toFixed(1))
        : 0;
      const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      reviews.forEach(r => { distribution[r.rating] = (distribution[r.rating] || 0) + 1; });
      return json({
        reviews: reviews.sort((a, b) => b.createdAt - a.createdAt),
        stats: { total, avgRating, distribution },
      });
    }

    // POST /api/reviews?action=add — добавить отзыв
    if (req.method === 'POST' && action === 'add') {
      const body = await req.json();
      const { name, text, rating } = body;
      if (!name || !text || !rating) return json({ error: 'Заполните все поля' }, 400);
      if (name.length > 100) return json({ error: 'Имя слишком длинное' }, 400);
      if (text.length > 1000) return json({ error: 'Отзыв слишком длинный' }, 400);
      if (![1, 2, 3, 4, 5].includes(Number(rating))) return json({ error: 'Оценка от 1 до 5' }, 400);

      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const rlKey = 'rl:' + ip.split(',')[0].trim();
      const rl = (await kv.get(rlKey)) || { t: [] };
      const now = Date.now();
      const recent = rl.t.filter(t => now - t < 3600000).length;
      if (recent >= 3) return json({ error: 'Слишком много отзывов. Попробуйте позже.' }, 429);
      rl.t.push(now);
      await kv.set(rlKey, rl, { ex: 3600 });

      const review = {
        id: crypto.randomUUID(),
        name: sanitize(name),
        text: sanitize(text),
        rating: Number(rating),
        createdAt: now,
        reply: null,
      };
      const reviews = (await kv.get('all_reviews')) || [];
      reviews.push(review);
      await kv.set('all_reviews', reviews);
      return json({ success: true, review });
    }

    // POST /api/reviews?action=reply&id=xxx — ответить на отзыв
    if (req.method === 'POST' && action === 'reply' && id) {
      const adminKey = req.headers.get('X-Admin-Key');
      if (adminKey !== process.env.ADMIN_KEY) return json({ error: 'Нет доступа' }, 403);
      const body = await req.json();
      if (!body.text || body.text.length > 500) return json({ error: 'Текст ответа пуст или слишком длинный' }, 400);
      const reviews = (await kv.get('all_reviews')) || [];
      const review = reviews.find(r => r.id === id);
      if (!review) return json({ error: 'Отзыв не найден' }, 404);
      review.reply = { text: sanitize(body.text), createdAt: Date.now() };
      await kv.set('all_reviews', reviews);
      return json({ success: true, review });
    }

    // DELETE /api/reviews?action=delete&id=xxx — удалить отзыв
    if (req.method === 'DELETE' && action === 'delete' && id) {
      const adminKey = req.headers.get('X-Admin-Key');
      if (adminKey !== process.env.ADMIN_KEY) return json({ error: 'Нет доступа' }, 403);
      const reviews = (await kv.get('all_reviews')) || [];
      const filtered = reviews.filter(r => r.id !== id);
      if (filtered.length === reviews.length) return json({ error: 'Отзыв не найден' }, 404);
      await kv.set('all_reviews', filtered);
      return json({ success: true });
    }

    // DELETE /api/reviews?action=delete-reply&id=xxx — удалить ответ
    if (req.method === 'DELETE' && action === 'delete-reply' && id) {
      const adminKey = req.headers.get('X-Admin-Key');
      if (adminKey !== process.env.ADMIN_KEY) return json({ error: 'Нет доступа' }, 403);
      const reviews = (await kv.get('all_reviews')) || [];
      const review = reviews.find(r => r.id === id);
      if (!review) return json({ error: 'Отзыв не найден' }, 404);
      review.reply = null;
      await kv.set('all_reviews', reviews);
      return json({ success: true });
    }

    return json({ error: 'Неизвестное действие' }, 400);
  } catch (err) {
    return json({ error: 'Ошибка сервера: ' + err.message }, 500);
  }
}

export const config = { runtime: 'edge' };