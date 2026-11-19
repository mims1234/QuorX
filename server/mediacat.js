// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The media catalogues the tools and pickers use: OpenRouter's pictures, videos and music, plus those of a media
// source the user switched on with a key (ToAPIs: toapis.js). A model id says where a call goes: `toapis-api/…`
// runs on ToAPIs, anything else on OpenRouter. A source that fails to list leaves OpenRouter's list as it is.
import * as OR from './openrouter.js';
import { sourceOn, keyFor, baseFor } from './sources.js';
import { TOAPIS_ID, isToapisModel, toapisImageModels, toapisVideoModels, toapisMusicModels, toapisImage, toapisVideo, toapisMusic } from './toapis.js';

const toapis = () => ({ key: keyFor(TOAPIS_ID)?.key, base: baseFor(TOAPIS_ID) });
const withSource = async (orList, list) => {
  if (!sourceOn(TOAPIS_ID)) return orList;
  const own = await orList.catch(() => []); // OpenRouter down: the source's models still show
  return [...own, ...await list(toapis()).catch(() => [])];
};

export const imageModels = () => withSource(OR.imageModels(), toapisImageModels);
export const videoModels = () => withSource(OR.videoModels(), toapisVideoModels);
export const musicModels = () => withSource(OR.musicModels(), toapisMusicModels);

export const generateImage = (body, signal) => (isToapisModel(body?.model) ? toapisImage(body, signal, toapis()) : OR.generateImage(body, signal));
export const generateVideo = (body, signal, onStatus) => (isToapisModel(body?.model) ? toapisVideo(body, signal, onStatus, toapis()) : OR.generateVideo(body, signal, onStatus));
export const composeMusic = (args, signal) => (isToapisModel(args?.model) ? toapisMusic(args, signal, toapis()) : OR.composeMusic(args, signal));
