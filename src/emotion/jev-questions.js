"use strict";

const VOCABULARY = Object.freeze({
  neutral: "Plain information without a clear feeling",
  joy: "Happy, pleased or delighted", trust: "Warm, reassuring or grateful",
  fear: "Worried, nervous or scared", surprise: "Surprised or amazed",
  sadness: "Sad, disappointed or apologetic", disgust: "Disgusted or unimpressed",
  anger: "Angry, annoyed or indignant", anticipation: "Eager or looking forward to something",
});
function questions(listening = false) {
  return {
    emotion: { type: "choice", criteria: VOCABULARY, instructions: listening
      ? "Which feeling would an attentive listener show in reaction to the speaker's line?"
      : "Which feeling does the speaker's line mainly express?" },
    strong: { type: "noul", instructions: "The feeling is strong and would show clearly on a face, rather than just a light tone." },
  };
}
module.exports = { VOCABULARY, questions };
