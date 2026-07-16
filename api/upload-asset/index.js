/**
 * upload-asset — POST /api/upload-asset  { name, type, dataBase64 }  (auth-gated)
 * Stores an uploaded photo or PDF the AI can use as content. Returns a
 * descriptor { id, url, name, type, size }; the file is served from /api/asset.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { putAsset } = require('../lib/assetStore');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  const { name, type, dataBase64 } = req.body || {};
  if (!dataBase64 || typeof dataBase64 !== 'string') {
    context.res = { status: 400, body: { error: 'No file data provided.' } };
    return;
  }
  try {
    const buffer = Buffer.from(dataBase64, 'base64');
    const asset = await putAsset(email, { name, type, buffer });
    context.res = { status: 200, body: { status: 'ok', asset } };
  } catch (err) {
    // Validation errors (type/size) are the user's to fix — surface them as 400.
    const bad = /larger than|supported|Empty file/.test(err.message);
    context.log[bad ? 'warn' : 'error'](err.message);
    context.res = { status: bad ? 400 : 500, body: { error: bad ? err.message : 'Upload failed.' } };
  }
};
