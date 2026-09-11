import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GraphMemory, tokenize } from "./engine.ts";

function freshGraph(): GraphMemory {
  return new GraphMemory(new DatabaseSync(":memory:"));
}

test("upsert merges properties and keeps the original creation time", () => {
  const graph = freshGraph();
  const first = graph.upsertNode("Episode", "frame_1", {
    type: "screen_chunk",
    title: "Editor",
    content: "hello world",
  }, { createdAt: "2026-01-01T00:00:00.000Z" });
  const second = graph.upsertNode("Episode", "frame_1", { salience: 0.9, title: null });

  assert.equal(second.created_at, first.created_at);
  assert.equal(second.props.content, "hello world");
  assert.equal(second.props.salience, 0.9);
  assert.equal("title" in second.props, false);
  assert.equal(graph.count({ label: "Episode" }), 1);
});

test("match filters on label and property equality, including booleans", () => {
  const graph = freshGraph();
  graph.upsertNode("Fact", "f1", { fact_key: "city", current: true, text: "city: Austin" });
  graph.upsertNode("Fact", "f2", { fact_key: "city", current: false, text: "city: Denver" });
  graph.upsertNode("Fact", "f3", { fact_key: "job", current: true, text: "job: engineer" });

  const current = graph.match({ label: "Fact", where: { fact_key: "city", current: true } });
  assert.deepEqual(current.map((n) => n.key), ["f1"]);
  assert.equal(graph.count({ label: "Fact", where: { current: true } }), 2);
});

test("edges are directed, unique, and walkable in both directions", () => {
  const graph = freshGraph();
  graph.upsertNode("Episode", "a", { content: "a" });
  graph.upsertNode("Episode", "b", { content: "b" });
  graph.upsertNode("Episode", "c", { content: "c" });

  assert.ok(graph.link("b", "FOLLOWS", "a"));
  assert.ok(graph.link("b", "FOLLOWS", "a", { weight: 0.5 }));
  assert.ok(graph.link("c", "FOLLOWS", "b"));
  assert.equal(graph.link("a", "FOLLOWS", "a"), null);
  assert.equal(graph.link("a", "FOLLOWS", "missing"), null);

  assert.equal(graph.stats().edges, 2);
  assert.deepEqual(
    graph.neighbors("b", { direction: "out" }).map((n) => n.node.key),
    ["a"]
  );
  assert.deepEqual(
    graph.neighbors("b", { direction: "in" }).map((n) => n.node.key),
    ["c"]
  );

  const walk = graph.traverse("c", { hops: 2 });
  assert.deepEqual(walk.nodes.map((n) => n.key).sort(), ["a", "b", "c"]);
  assert.equal(walk.edges.length, 2);
});

test("deleting a node removes its edges and search entry", () => {
  const graph = freshGraph();
  graph.upsertNode("Episode", "a", { content: "alpha" });
  graph.upsertNode("Episode", "b", { content: "beta" });
  graph.link("a", "FOLLOWS", "b");
  graph.deleteNode("a");

  assert.equal(graph.getNode("a"), null);
  assert.equal(graph.stats().edges, 0);
  assert.equal(graph.search("alpha").length, 0);
});

test("search ranks by token coverage and abstains on unrelated queries", () => {
  const graph = freshGraph();
  graph.upsertNode("Episode", "e1", {
    type: "screen_chunk",
    content: "Reviewing the quarterly budget spreadsheet for the Atlas project",
  });
  graph.upsertNode("Episode", "e2", {
    type: "screen_chunk",
    content: "Watching a documentary about deep sea creatures",
  });
  graph.upsertNode("Fact", "f1", { current: true, text: "Atlas project launch is Friday" });

  const hits = graph.search("when is the atlas project launch");
  assert.equal(hits[0]?.node.key, "f1");
  assert.ok(hits.every((hit) => hit.node.key !== "e2"));

  assert.deepEqual(
    graph.search("atlas", { label: "Episode" }).map((hit) => hit.node.key),
    ["e1"]
  );
  assert.equal(graph.search("basketball tournament results").length, 0);
});

test("tokenize drops stop words and short tokens", () => {
  assert.deepEqual(tokenize("What was I doing in the Atlas project?"), [
    "doing",
    "atlas",
    "project",
  ]);
});

test("stats break nodes down by label, type, and relation", () => {
  const graph = freshGraph();
  graph.upsertNode("Episode", "e1", { type: "screen_chunk", content: "x" });
  graph.upsertNode("Episode", "e2", { type: "audio_chunk", content: "y" });
  graph.upsertNode("Fact", "f1", { type: "fact", text: "z" });
  graph.link("e1", "RECORDED_AS", "f1");

  const stats = graph.stats();
  assert.equal(stats.nodes, 3);
  assert.equal(stats.edges, 1);
  assert.deepEqual(stats.byLabel, { Episode: 2, Fact: 1 });
  assert.deepEqual(stats.byType, { screen_chunk: 1, audio_chunk: 1, fact: 1 });
  assert.deepEqual(stats.byRelation, { RECORDED_AS: 1 });
});
