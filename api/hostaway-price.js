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

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function buildHolidayFutureUrls({ listingId, checkIn, checkOut, adults, children }) {
  const base = 'https://174903_1.holidayfuture.com';

  const checkoutUrl = new URL(`${base}/checkout/${listingId}`);
  checkoutUrl.searchParams.set('checkIn', checkIn);
  checkoutUrl.searchParams.set('checkOut', checkOut);
  checkoutUrl.searchParams.set('adults', String(adults));
  checkoutUrl.searchParams.set('children', String(children));

  const inquiryUrl = new URL(`${base}/inquiry/${listingId}`);
  inquiryUrl.searchParams.set('checkIn', checkIn);
  inquiryUrl.searchParams.set('checkOut', checkOut);
  inquiryUrl.searchParams.set('adults', String(adults));
  inquiryUrl.searchParams.set('children', String(children));

  return {
    checkoutUrl: checkoutUrl.toString(),
    inquiryUrl: inquiryUrl.toString()
  };
}

function parseDateOnly(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}

function getNightCount(checkIn, checkOut) {
  const ms = parseDateOnly(checkOut).getTime() - parseDateOnly(checkIn).getTime();
  return Math.round(ms / 86400000);
}

function extractPositiveInt(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;

  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return fallback;
}

function extractBoolean(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;

  for (const key of keys) {
    if (key in obj) {
      const value = obj[key];

      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value === 1;
      if (typeof value === 'string') {
        const normalized = value.toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0') return false;
      }
    }
  }

  return fallback;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

  if (!isValidIsoDate(checkIn) || !isValidIsoDate(checkOut)) {
    return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  }

  const listingId = process.env.HOSTAWAY_LISTING_ID;
  const maxGuestsEnv = Number(process.env.HOSTAWAY_MAX_GUESTS || 0);
  const maxGuests = Number.isFinite(maxGuestsEnv) && maxGuestsEnv > 0 ? maxGuestsEnv : null;

  if (!listingId) {
    return res.status(500).json({ error: 'Missing HOSTAWAY_LISTING_ID' });
  }

  const nights = getNightCount(checkIn, checkOut);
  if (!Number.isFinite(nights) || nights <= 0) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  const adultsNum = Math.max(1, Number(adults || 0));
  const childrenNum = Math.max(0, Number(children || 0));
  const numberOfGuests = Math.max(1, adultsNum + childrenNum);

  const { checkoutUrl, inquiryUrl } = buildHolidayFutureUrls({
    listingId,
    checkIn,
    checkOut,
    adults: adultsNum,
    children: childrenNum
  });

  if (maxGuests && numberOfGuests > maxGuests) {
    return res.status(200).json({
      valid: false,
      available: false,
      reason: 'maxGuests',
      message: `Maximum guest count is ${maxGuests}`,
      checkIn,
      checkOut,
      nights,
      adults: adultsNum,
      children: childrenNum,
      numberOfGuests,
      minStay: null,
      maxGuests,
      totalPrice: null,
      nightlyRate: null,
      cleaningFee: null,
      taxes: null,
      bookingEngineFee: null,
      checkoutUrl,
      inquiryUrl
    });
  }

  try {
    const accessToken = await getHostawayAccessToken();

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
    const checkInDay = days[0] || null;

    const unavailable = days.some((d) => Number(d.isAvailable) !== 1);
    if (unavailable) {
      return res.status(200).json({
        valid: false,
        available: false,
        reason: 'unavailable',
        message: 'Those dates are not available',
        checkIn,
        checkOut,
        nights,
        adults: adultsNum,
        children: childrenNum,
        numberOfGuests,
        minStay: null,
        maxGuests,
        totalPrice: null,
        nightlyRate: null,
        cleaningFee: null,
        taxes: null,
        bookingEngineFee: null,
        checkoutUrl,
        inquiryUrl
      });
    }

    const minStay = extractPositiveInt(
      checkInDay,
      ['minStay', 'minimumStay', 'minimumNights', 'minNights', 'minimumNumberOfNights'],
      1
    );

    if (nights < minStay) {
      return res.status(200).json({
        valid: false,
        available: false,
        reason: 'minStay',
        message: `Minimum stay is ${minStay} night${minStay === 1 ? '' : 's'}`,
        checkIn,
        checkOut,
        nights,
        adults: adultsNum,
        children: childrenNum,
        numberOfGuests,
        minStay,
        maxGuests,
        totalPrice: null,
        nightlyRate: null,
        cleaningFee: null,
        taxes: null,
        bookingEngineFee: null,
        checkoutUrl,
        inquiryUrl
      });
    }

    const checkInAllowed = extractBoolean(
      checkInDay,
      ['isCheckInAllowed', 'checkInAllowed', 'allowCheckIn'],
      true
    );

    if (!checkInAllowed) {
      return res.status(200).json({
        valid: false,
        available: false,
        reason: 'checkInBlocked',
        message: 'Check-in is not allowed on that date',
        checkIn,
        checkOut,
        nights,
        adults: adultsNum,
        children: childrenNum,
        numberOfGuests,
        minStay,
        maxGuests,
        totalPrice: null,
        nightlyRate: null,
        cleaningFee: null,
        taxes: null,
        bookingEngineFee: null,
        checkoutUrl,
        inquiryUrl
      });
    }

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
    const totalPrice = toNumberOrNull(result.totalPrice);
    const nightlyRate = totalPrice !== null && nights > 0 ? totalPrice / nights : null;
    const cleaningFee = toNumberOrNull(result.cleaningFee);
    const taxes = toNumberOrNull(result.taxes);
    const bookingEngineFee =
      toNumberOrNull(result.bookingEngineFee) ??
      toNumberOrNull(result.guestServiceFee) ??
      null;

    return res.status(200).json({
      valid: true,
      available: true,
      reason: 'ok',
      message: 'ok',
      checkIn,
      checkOut,
      nights,
      adults: adultsNum,
      children: childrenNum,
      numberOfGuests,
      minStay,
      maxGuests,
      totalPrice,
      nightlyRate,
      cleaningFee,
      taxes,
      bookingEngineFee,
      checkoutUrl,
      inquiryUrl
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Server error'
    });
  }
}
