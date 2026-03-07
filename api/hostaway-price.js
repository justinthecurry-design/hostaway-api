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

  const numberOfGuests = Math.max(1, Number(adults || 0) + Number(children || 0));
  const listingId = process.env.HOSTAWAY_LISTING_ID;
  const token = process.env.HOSTAWAY_TOKEN;

  if (!listingId || !token) {
    return res.status(500).json({ error: 'Missing Hostaway env vars' });
  }

  try {
    // 1) Availability check
    const calendarRes = await fetch(
      `https://api.hostaway.com/v1/listings/${listingId}/calendar?startDate=${checkIn}&endDate=${checkOut}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
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
        nights: 0
      });
    }

    // 2) Price calculation
    const priceRes = await fetch(
      `https://api.hostaway.com/v1/listings/${listingId}/calendar/priceDetails`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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
    const totalPrice = typeof result.totalPrice === 'number'
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
      nights
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
