import { kv } from '@vercel/kv';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

function jsonResponse(data, status = 200) {
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
  const path = url.pathname.replace('/api/reviews', '').replace(/^\//, '');

  try {
    // GET /api/reviews
    if (req.method === 'GET' && !path) {
      const reviews = (await kv.get('all_reviews')) || [];
      const total = reviews.length;
      const avgRating = total > 0
        ? parseFloat((reviews.reduce((s, r) => s + r.rating, 0) / total).toFixed(1))
        : 0;
      const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      reviews.forEach(r => { distribution[r.rating] = (distribution[r.rating] || 0) + 1; });
      return jsonResponse({
        reviews: reviews.sort((a, b) => b.createdAt - a.createdAt),
        stats: { total, avgRating, distribution },
      });
    }

    // POST /api/reviews
    if (req.method === 'POST' && !path) {
      const body = await req.json();
      const { name, text, rating } = body;
      if (!name || !text || !rating) return jsonResponse({ error: 'Заполните все поля' }, 400);
      if (name.length > 100) return jsonResponse({ error: 'Имя слишком длинное' }, 400);
      if (text.length > 1000) return jsonResponse({ error: 'Отзыв слишком длинный' }, 400);
      if (![1, 2, 3, 4, 5].includes(Number(rating))) return jsonResponse({ error: 'Оценка от 1 до 5' }, 400);

      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      const rateLimitKey = 'ratelimit:' + ip.split(',')[0].trim();
      const rateData = (await kv.get(rateLimitKey)) || { timestamps: [] };
      const now = Date.now();
      const recentCount = rateData.timestamps.filter(t => now - t < 3600000).length;
      if (recentCount >= 3) return jsonResponse({ error: 'Слишком много отзывов. Попробуйте позже.' }, 429);
      rateData.timestamps.push(now);
      await kv.set(rateLimitKey, rateData, { ex: 3600 });

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
      return jsonResponse({ success: true, review });
    }

    // POST /api/reviews/:id/reply
    if (req.method === 'POST' && path.endsWith('/reply')) {
      const adminKey = req.headers.get('X-Admin-Key');
      if (adminKey !== process.env.ADMIN_KEY) return jsonResponse({ error: 'Нет доступа' }, 403);
      const id = path.replace('/reply', '');
      const body = await req.json();
      if (!body.text || body.text.length > 500) return jsonResponse({ error: 'Текст ответа пуст или слишком длинный' }, 400);
      const reviews = (await kv.get('all_reviews')) || [];
      const review = reviews.find(r => r.id === id);
      if (!review) return jsonResponse({ error: 'Отзыв не найден' }, 404);
      review.reply = { text: sanitize(body.text), createdAt: Date.now() };
      await kv.set('all_reviews', reviews);
      return jsonResponse({ success: true, review });
    }

    // DELETE /api/reviews/:id/reply
    if (req.method === 'DELETE' && path.endsWith('/reply')) {
      const adminKey = req.headers.get('X-Admin-Key');
      if (adminKey !== process.env.ADMIN_KEY) return jsonResponse({ error: 'Нет доступа' }, 403);
      const id = path.replace('/reply', '');
      const reviews = (await kv.get('all_reviews')) || [];
      const review = reviews.find(r => r.id === id);
      if (!review) return jsonResponse({ error: 'Отзыв не найден' }, 404);
      review.reply = null;
      await kv.set('all_reviews', reviews);
      return jsonResponse({ success: true });
    }

    // DELETE /api/reviews/:id
    if (req.method === 'DELETE' && path && !path.includes('/')) {
      const adminKey = req.headers.get('X-Admin-Key');
      if (adminKey !== process.env.ADMIN_KEY) return jsonResponse({ error: 'Нет доступа' }, 403);
      const reviews = (await kv.get('all_reviews')) || [];
      const filtered = reviews.filter(r => r.id !== path);
      if (filtered.length === reviews.length) return jsonResponse({ error: 'Отзыв не найден' }, 404);
      await kv.set('all_reviews', filtered);
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Не найдено' }, 404);
  } catch (err) {
    return jsonResponse({ error: 'Ошибка сервера: ' + err.message }, 500);
  }
}

export const config = { runtime: 'edge' };