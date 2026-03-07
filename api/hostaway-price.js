let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getHostawayAccessToken() {
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.HOSTAWAY_ACCOUNT_ID;
  const clientSecret = process.env.HOSTAWAY_API_KEY;

  if (!clientId || !clientSecret) {
    throw new Error('Missing HOSTAWAY_ACCOUNT_ID or HOSTAWAY_API_KEY');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'general'
  });

  const tokenRes = await fetch('https://api.hostaway.com/v1/accessTokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache'
    },
    body: body.toString()
  });

  const tokenJson = await tokenRes.json();

  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(
      tokenJson.error_description ||
      tokenJson.message ||
      'Unable to generate Hostaway access token'
    );
  }

  cachedToken = tokenJson.access_token;
  const ttlMs = ((tokenJson.expires_in || 3600) - 60) * 1000;
  cachedTokenExpiresAt = Date.now() + ttlMs;

  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { checkIn, checkOut, adults = '2', children = '0' } = req.query;

  if (!checkIn || !checkOut) {
    return res.status(400).json({ error: 'Missing checkIn/checkOut' });
  }

  const listingId = process.env.HOSTAWAY_LISTING_ID;

  if (!listingId) {
    return res.status(500).json({ error: 'Missing HOSTAWAY_LISTING_ID' });
  }

  const numberOfGuests = Math.max(1, Number(adults || 0) + Number(children || 0));

  try {
    const accessToken = await getHostawayAccessToken();

    // Build checkout URL directly instead of trying to discover it from API
    const checkoutUrl = `https://174903_1.holidayfuture.com/reserve/${listingId}`;

    // Check availability
    const calendarRes = await fetch(
      `https://api.hostaway.com/v1/listings/${listingId}/calendar?startDate=${checkIn}&endDate=${checkOut}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Cache-Control': 'no-cache'
        }
      }
    );

    const calendarJson = await calendarRes.json();

    if (!calendarRes.ok || calendarJson.status === 'fail') {
      return res.status(400).json({
        error: calendarJson.message || calendarJson.result || 'Calendar lookup failed'
      });
    }

    const days = Array.isArray(calendarJson.result) ? calendarJson.result : [];
    const unavailable = days.some((d) => Number(d.isAvailable) !== 1);

    if (unavailable) {
      return res.status(200).json({
        available: false,
        totalPrice: null,
        nightlyRate: null,
        nights: 0,
        checkoutUrl
      });
    }

    // Calculate price
    const priceRes = await fetch(
      `https://api.hostaway.com/v1/listings/${listingId}/calendar/priceDetails`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify({
          startingDate: checkIn,
          endingDate: checkOut,
          numberOfGuests,
          version: 2
        })
      }
    );

    const priceJson = await priceRes.json();

    if (!priceRes.ok || priceJson.status === 'fail') {
      return res.status(400).json({
        error: priceJson.message || priceJson.result || 'Price calculation failed'
      });
    }

    const result = priceJson.result || {};
    const totalPrice =
      typeof result.totalPrice === 'number'
        ? result.totalPrice
        : Number(result.totalPrice || 0);

    const nights = Math.max(
      1,
      Math.round(
        (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000
      )
    );

    const nightlyRate = nights > 0 ? totalPrice / nights : totalPrice;

    return res.status(200).json({
      available: true,
      totalPrice,
      nightlyRate,
      nights,
      checkoutUrl
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
}
