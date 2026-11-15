'use strict';
// Shared media links for the journey templates approved with a picture or video header.
// A template approved with a header is rejected by Meta if a send leaves the header out.
const MEDIA_BASE = 'https://munchingo.com/media/';

const checkinImage = () => MEDIA_BASE + 'checkin.jpg';
const reorderImage = (slug) => MEDIA_BASE + (slug ? `reorder-${slug}.jpg` : 'reorder-all.jpg');
const unlockVideo = () => process.env.JOURNEY_UNLOCK_VIDEO_URL || null;

module.exports = { MEDIA_BASE, checkinImage, reorderImage, unlockVideo };
