/**
 * asset — GET /api/asset?id=<blobId>   (public)
 * Serves an uploaded photo/PDF so it can be referenced by <img src> in the
 * preview iframe and on the live site. Public by design: these are site media,
 * not secrets, and the blob id is an unguessable UUID.
 */
const { getAsset } = require('../lib/assetStore');

module.exports = async function (context, req) {
  const id = req.query && req.query.id;
  if (!id) {
    context.res = { status: 400, body: 'Missing id.' };
    return;
  }
  try {
    const asset = await getAsset(id);
    if (!asset) {
      context.res = { status: 404, body: 'Not found.' };
      return;
    }
    context.res = {
      status: 200,
      headers: { 'Content-Type': asset.contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
      body: asset.buffer,
      isRaw: true,
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: 'Error.' };
  }
};
