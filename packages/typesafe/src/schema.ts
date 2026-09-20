import { Schema } from "effect";

// Hand-maintained from https://docs.typesafe.ai/api (2026-09-19).
// String rubrics are the subset supported by Effect DecisionModel.
export const Question = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: Schema.String,
    criteria: Schema.optional(
      Schema.Struct({ true: Schema.String, false: Schema.String }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Schema.String,
    criteria: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: Schema.String,
    criteria: Schema.Array(Schema.String),
  }),
]);
export const SystemOneRequest = Schema.Struct({
  model: Schema.String,
  state: Schema.Json,
  questions: Schema.Record(Schema.String, Question),
});
const Probability = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
export const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Probability,
    probabilities: Schema.Record(Schema.String, Probability),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Finite,
    confidence: Probability,
    probabilities: Schema.Record(Schema.String, Probability),
    legend: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
export const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
      output_tokens: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
    }),
  ),
});
export const ListModelsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      release_date: Schema.optional(Schema.String),
    }),
  ),
});
