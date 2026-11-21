// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What the paid media tools take besides a prompt: reference pictures (imagine, make_video), an end picture
// (make_video) and a voice to copy from a recording (speak), each only with a model that takes it.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reply, run, toolResults, of } from './agent-harness.mjs';
import { primeCatalogue } from '../server/openrouter.js';
import { videoBody } from '../server/video.js';
import { imageRefMax, voiceClone, speechRefs, pictureRefs, mediaInputs } from '../server/mediainputs.js';

const PNG = (s) => `data:image/png;base64,${Buffer.from(s).toString('base64')}`;
const IMG_REF = { id: 'test/img-ref', name: 'Ref', kind: 'image', in: ['text', 'image'], out: ['image'], price: [0, 0], perImage: 0.02, params: { input_references: { type: 'range', min: 0, max: 2 } } };
const IMG_TEXT = { id: 'test/img-text', name: 'Text', kind: 'image', in: ['text'], out: ['image'], price: [0, 0], perImage: 0.02, params: {} };
const imageSettings = (model) => ({ mediaEnabled: true, yoloCheck: false, tools: { browser: { on: false }, video: { on: false }, music: { on: false }, speech: { on: false }, image: { on: true, pick: 'fixed', models: [model], resolution: '1K' } } });
const TTS_CLONE = { id: 'test/tts-clone', name: 'Clone', kind: 'speech', in: ['text'], out: ['speech'], price: [10, 0], voices: [] };
const TTS_PLAIN = { id: 'test/tts-plain', name: 'Plain', kind: 'speech', in: ['text'], out: ['speech'], price: [10, 0], voices: ['amy'] };
const speechSettings = (model) => ({ mediaEnabled: true, yoloCheck: false, tools: { browser: { on: false }, video: { on: false }, music: { on: false }, image: { on: false }, speech: { on: true, pick: 'fixed', models: [model], voices: {} } } });
const primeSpeech = () => {
  primeCatalogue('speech', [TTS_CLONE, TTS_PLAIN]);
  primeCatalogue('speech-ep:test/tts-clone', [{ supports_voice_cloning: true, supports_multiple_audio_references: false }]);
  primeCatalogue('speech-ep:test/tts-plain', [{ supports_voice_cloning: false }]);
};
const fakeImage = (sent) => async (b) => { sent.push(b); return { images: [PNG('made')], usage: { cost: 0.02 }, ms: 5 }; };

test('what each model takes, from the catalogues', async () => {
  assert.equal(imageRefMax(IMG_REF), 2);
  assert.equal(imageRefMax(IMG_TEXT), 0);
  assert.equal(imageRefMax({ params: { input_references: { type: 'range', min: 0, max: 40 } } }), 16, 'OpenRouter takes 16 at most');
  assert.deepEqual(voiceClone([{ supports_voice_cloning: false }, { supports_voice_cloning: true, supports_multiple_audio_references: true }]), { multi: true, image: false });
  assert.equal(voiceClone([{ supports_voice_cloning: false }]), null);
  assert.equal(voiceClone(undefined), null);
  // One recording for a model that takes one, up to three otherwise; the transcript as a text part.
  assert.deepEqual(speechRefs(['data:audio/wav;base64,A', 'data:audio/wav;base64,B'], ' hello ', { multi: false }), [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,A' } }, { type: 'text', text: 'hello' }]);
  assert.equal(speechRefs(['a', 'b', 'c', 'd'], '', { multi: true }).length, 3);
  assert.deepEqual(pictureRefs(['u']), [{ type: 'image_url', image_url: { url: 'u' } }]);
  const T = { image: { models: ['test/img-ref', 'test/img-text'] }, video: { models: ['v/both', 'v/start'] }, speech: { models: ['test/tts-clone', 'test/tts-plain'] } };
  const got = await mediaInputs(['image', 'video', 'speech'], T, {
    images: async () => [IMG_REF, IMG_TEXT], videos: async () => [{ id: 'v/both', frames: ['first_frame', 'last_frame'] }, { id: 'v/start', frames: ['first_frame'] }, { id: 'v/unused', frames: ['last_frame'] }],
    speechEndpoints: async (id) => (id === 'test/tts-clone' ? [{ supports_voice_cloning: true }] : []),
  });
  assert.deepEqual(got, { imageRefs: { 'test/img-ref': 2 }, videoStart: ['v/both', 'v/start'], videoEnd: ['v/both'], voiceClone: { 'test/tts-clone': { multi: false, image: false } } });
});

test('a clip can end on a picture and be guided by reference pictures; the frames win when both are given', () => {
  const spec = { frames: ['first_frame', 'last_frame'] };
  const both = videoBody({ model: 'v/a', prompt: 'x', spec, firstFrame: 'F', lastFrame: 'L', references: ['R'] });
  assert.deepEqual(both.body.frame_images.map((f) => [f.frame_type, f.image_url.url]), [['first_frame', 'F'], ['last_frame', 'L']]);
  assert.equal('input_references' in both.body, false);
  assert.match(both.note, /reference pictures were left out/);
  assert.deepEqual(videoBody({ model: 'v/a', prompt: 'x', spec, references: ['R1', 'R2'] }).body.input_references, [{ type: 'image_url', image_url: { url: 'R1' } }, { type: 'image_url', image_url: { url: 'R2' } }]);
  assert.match(videoBody({ model: 'v/b', prompt: 'x', spec: { frames: ['first_frame'] }, lastFrame: 'L' }).error, /can't end on a picture/);
});

test('make_video can start on one picture and end on another with a model that takes both; others are refused before paying', async () => {
  const V = { id: 'test/vid-both', name: 'Both', kind: 'video', skus: { duration_seconds_480p: 0.02 }, resolutions: ['480p'], durations: [5], aspects: ['16:9'], frames: ['first_frame', 'last_frame'] };
  const V1 = { ...V, id: 'test/vid-first', frames: ['first_frame'] };
  primeCatalogue('videos', [V, V1]);
  const settings = (m) => ({ mediaEnabled: true, yoloCheck: false, tools: { browser: { on: false }, image: { on: false }, music: { on: false }, speech: { on: false }, video: { on: true, pick: 'fixed', models: [m], resolution: '480p', seconds: 5 } } });
  const prep = (d) => { fs.mkdirSync(path.join(d, 'assets')); fs.writeFileSync(path.join(d, 'assets', 'a.png'), 'A'); fs.writeFileSync(path.join(d, 'assets', 'b.png'), 'B'); };
  const sent = [];
  const fake = async (b) => { sent.push(b); return { url: 'data:video/mp4;base64,AA', usage: { cost: 0.1 }, ms: 5 }; };
  const { bodies, events } = await run((body, i) => [reply('', [['make_video', { prompt: 'dawn to dusk', why: 'x', start_image: 'assets/a.png', end_image: 'assets/b.png' }]]), reply('Done.')][i], { settings: settings('test/vid-both'), prep, generateVideo: fake });
  assert.deepEqual(sent[0].frame_images.map((f) => [f.frame_type, f.image_url.url]), [['first_frame', PNG('A')], ['last_frame', PNG('B')]]);
  assert.match(of(events, 'approval')[0].detail, /ending on assets\/b\.png/);
  assert.match(bodies[0].tools.find((t) => t.function.name === 'make_video').function.parameters.properties.end_image.description, /test\/vid-both/);
  const r2 = await run((body, i) => [reply('', [['make_video', { prompt: 'x', why: 'x', end_image: 'assets/b.png' }]]), reply('Done.')][i], { settings: settings('test/vid-first'), prep, generateVideo: fake });
  assert.match(toolResults(r2.bodies[1]).at(-1), /^Error: test\/vid-first can't end on a picture/);
  assert.equal(sent.length, 1);
  assert.equal(of(r2.events, 'approval').length, 0);
});

test("imagine works from the user's attached photo and project pictures with a model that takes them", async () => {
  primeCatalogue('images', [IMG_REF, IMG_TEXT]);
  const sent = [];
  const { bodies, events } = await run((body, i) => [
    reply('', [['imagine', { prompt: 'the same cat as a watercolour', why: 'asked', references: ['attached:1', 'assets/style.png'] }]]),
    reply('Done.'),
  ][i], { settings: imageSettings('test/img-ref'), images: [PNG('users-photo')], prep: (d) => { fs.mkdirSync(path.join(d, 'assets')); fs.writeFileSync(path.join(d, 'assets', 'style.png'), 'style'); }, generateImage: fakeImage(sent) });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].input_references, [{ type: 'image_url', image_url: { url: PNG('users-photo') } }, { type: 'image_url', image_url: { url: PNG('style') } }]);
  assert.match(toolResults(bodies[1]).at(-1), /Worked from 2 reference pictures/);
  assert.match(of(events, 'approval')[0].detail, /working from attached:1, assets\/style\.png/);
  const tool = bodies[0].tools.find((t) => t.function.name === 'imagine');
  assert.equal(tool.function.parameters.properties.references.maxItems, 2);
  assert.match(tool.function.parameters.properties.references.description, /test\/img-ref \(2\)/);
});

test('imagine with pictures and a text-only model, or a picture that is not there, is refused before any approval or charge', async () => {
  primeCatalogue('images', [IMG_REF, IMG_TEXT]);
  {
    const sent = [];
    const { bodies, events } = await run((body, i) => [reply('', [['imagine', { prompt: 'x', why: 'y', references: ['attached:1'] }]]), reply('Done.')][i],
      { settings: imageSettings('test/img-text'), images: [PNG('p')], generateImage: fakeImage(sent) });
    assert.match(toolResults(bodies[1]).at(-1), /^Error: test\/img-text can't work from pictures\. None of the picture models in use can/);
    assert.equal(sent.length, 0);
    assert.equal(of(events, 'approval').length, 0);
    assert.equal('references' in bodies[0].tools.find((t) => t.function.name === 'imagine').function.parameters.properties, false, 'not offered at all');
  }
  {
    const sent = [];
    const { bodies } = await run((body, i) => [reply('', [['imagine', { prompt: 'x', why: 'y', references: ['assets/missing.png'] }]]), reply('Done.')][i],
      { settings: imageSettings('test/img-ref'), generateImage: fakeImage(sent) });
    assert.match(toolResults(bodies[1]).at(-1), /^Error: no picture at assets\/missing\.png/);
    assert.equal(sent.length, 0);
  }
  { // More pictures than any model in use takes: the tool's own limit turns the call back, nothing is sent.
    const sent = [];
    const { bodies } = await run((body, i) => [reply('', [['imagine', { prompt: 'x', why: 'y', references: ['attached:1', 'attached:2', 'attached:3'] }]]), reply('Done.')][i],
      { settings: imageSettings('test/img-ref'), images: [PNG('a'), PNG('b'), PNG('c')], generateImage: fakeImage(sent) });
    assert.match(toolResults(bodies[1]).at(-1), /`references` can have at most 2 items/);
    assert.equal(sent.length, 0);
  }
});

test('speak copies a voice from a recording in the project with a model that clones, and only then', async () => {
  primeSpeech();
  {
    const sent = [];
    const wav = Buffer.from('RIFF-fake-wav');
    const { bodies, events } = await run((body, i) => [reply('', [['speak', { text: 'Welcome back.', why: 'narration', voice_sample: ['audio/me.wav'], voice_sample_text: 'This is me talking.', style: 'warm and slow' }]]), reply('Done.')][i],
      { settings: speechSettings('test/tts-clone'), prep: (d) => { fs.mkdirSync(path.join(d, 'audio')); fs.writeFileSync(path.join(d, 'audio', 'me.wav'), wav); },
        synthesize: async (b) => { sent.push(b); return { url: 'data:audio/mpeg;base64,AA', ms: 5 }; } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].references, [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }, { type: 'text', text: 'This is me talking.' }]);
    assert.match(toolResults(bodies[1]).at(-1), /in the voice of audio\/me\.wav/);
    assert.equal(sent[0].instructions, 'warm and slow', 'the style direction goes as instructions');
    assert.match(of(events, 'approval')[0].detail, /in the voice of audio\/me\.wav/);
    assert.match(bodies[0].tools.find((t) => t.function.name === 'speak').function.parameters.properties.voice_sample.description, /test\/tts-clone/);
  }
  {
    let called = 0;
    const { bodies, events } = await run((body, i) => [reply('', [['speak', { text: 'Hi', why: 'x', voice_sample: ['audio/me.wav'] }]]), reply('Done.')][i],
      { settings: speechSettings('test/tts-plain'), synthesize: async () => { called++; return {}; } });
    assert.match(toolResults(bodies[1]).at(-1), /^Error: test\/tts-plain can't speak in a voice from a recording\. None of the voice models in use can/);
    assert.equal(called, 0);
    assert.equal(of(events, 'approval').length, 0);
    assert.equal('voice_sample' in bodies[0].tools.find((t) => t.function.name === 'speak').function.parameters.properties, false);
  }
  { // Not a sound file, or outside the project: refused with the reason, nothing sent.
    let called = 0;
    for (const bad of ['notes.txt', '../outside.wav']) {
      const { bodies } = await run((body, i) => [reply('', [['speak', { text: 'Hi', why: 'x', voice_sample: [bad] }]]), reply('Done.')][i],
        { settings: speechSettings('test/tts-clone'), prep: (d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'x'), synthesize: async () => { called++; return {}; } });
      assert.match(toolResults(bodies[1]).at(-1), /^Error: /, bad);
    }
    assert.equal(called, 0);
  }
});
