#!/usr/bin/env node
/**
 * Unit test: database column settings (`data`).
 *
 * AFFiNE's number cell reads data.decimal/format, and the table header menu reads
 * data.format for every column, so a column stored without `data` renders blank and
 * its header menu throws. Verifies the exact `data` written on creation for every
 * supported column type, and that repair fixes columns created without it.
 */
import assert from "node:assert/strict";

import * as Y from "yjs";

import {
  createDatabaseColumnDefinition,
  DATABASE_NUMBER_FORMAT_VALUES,
  DATABASE_SELECT_COLORS,
  inspectDatabaseColumnData,
  repairDatabaseColumnsData,
} from "../dist/tools/docs.js";

/** Integrate a column into a doc so Y.Map contents are readable, as on the wire. */
function integrate(columns) {
  const doc = new Y.Doc();
  const block = doc.getMap("blocks").set("db", new Y.Map());
  const yColumns = new Y.Array();
  block.set("prop:columns", yColumns);
  yColumns.push(columns);
  block.set("prop:cells", new Y.Map());
  return { doc, block, yColumns };
}

// AFFiNE 0.27.4 propertyData.default() per type.
const expectedDefaults = {
  title: {},
  "rich-text": {},
  select: { options: [] },
  "multi-select": { options: [] },
  number: { decimal: 0, format: "number" },
  checkbox: {},
  link: {},
  date: {},
};

// Every type gets a `data` map, matching AFFiNE's own defaults.
for (const [type, expected] of Object.entries(expectedDefaults)) {
  const { yColumns } = integrate([createDatabaseColumnDefinition({ id: `c-${type}`, name: type, type })]);
  const column = yColumns.get(0);
  assert.ok(column.get("data") instanceof Y.Map, `${type}: data must be a Y.Map`);
  assert.deepEqual(column.get("data").toJSON(), expected, `${type}: default data`);
  assert.equal(inspectDatabaseColumnData(type, column.get("data")).status, "ok", `${type}: inspect ok`);
}

// Select options carry id/value/color in order.
{
  const { yColumns } = integrate([
    createDatabaseColumnDefinition({ id: "s", name: "Status", type: "select", options: ["Todo", "Done"] }),
  ]);
  const options = yColumns.get(0).get("data").get("options");
  assert.ok(options instanceof Y.Array);
  const json = options.toJSON();
  assert.deepEqual(json.map(option => option.value), ["Todo", "Done"]);
  assert.deepEqual(json.map(option => option.color), DATABASE_SELECT_COLORS.slice(0, 2));
  assert.ok(json.every(option => typeof option.id === "string" && option.id.length > 0));
}

// Number decimal/format pass through.
{
  const { yColumns } = integrate([
    createDatabaseColumnDefinition({ id: "n", name: "Amount", type: "number", decimal: 2, format: "currencyEUR" }),
  ]);
  assert.deepEqual(yColumns.get(0).get("data").toJSON(), { decimal: 2, format: "currencyEUR" });
}

assert.deepEqual([...DATABASE_NUMBER_FORMAT_VALUES], [
  "number", "numberWithCommas", "percent", "currencyYen", "currencyINR",
  "currencyCNY", "currencyUSD", "currencyEUR", "currencyGBP",
]);

// Inspection flags missing and invalid shapes.
assert.equal(inspectDatabaseColumnData("number", undefined).status, "missing");
assert.equal(inspectDatabaseColumnData("rich-text", undefined).status, "missing");
assert.equal(inspectDatabaseColumnData("number", { decimal: 9, format: "number" }).status, "invalid");
assert.equal(inspectDatabaseColumnData("number", { decimal: 1, format: "bogus" }).status, "invalid");
assert.equal(inspectDatabaseColumnData("select", {}).status, "invalid");
assert.equal(inspectDatabaseColumnData("select", "nope").status, "invalid");
assert.deepEqual(inspectDatabaseColumnData("number", { decimal: 3, format: "percent" }).summary, { decimal: 3, format: "percent" });
assert.deepEqual(inspectDatabaseColumnData("multi-select", { options: [{ id: "a", value: "A", color: "x" }] }).summary, { optionCount: 1 });
assert.equal(inspectDatabaseColumnData("progress", undefined).status, "unsupported");

/** Build a column the way affine-mcp-server <= 3.10.2 did: no `data` unless select options were given. */
function legacyColumn(id, name, type) {
  const column = new Y.Map();
  column.set("id", id);
  column.set("name", name);
  column.set("type", type);
  column.set("width", 200);
  return column;
}

// Repair fixes columns created the old way, keeps valid data, and never touches cells.
{
  const goodSelect = createDatabaseColumnDefinition({ id: "sel", name: "Status", type: "select", options: ["A"] });
  const badNumber = new Y.Map();
  badNumber.set("id", "num2");
  badNumber.set("name", "Pct");
  badNumber.set("type", "number");
  badNumber.set("width", 200);
  const badNumberData = new Y.Map();
  badNumberData.set("format", "percent");
  badNumberData.set("decimal", 42);
  badNumber.set("data", badNumberData);

  const { doc, block, yColumns } = integrate([
    legacyColumn("t", "Title", "title"),
    legacyColumn("num", "Amount", "number"),
    legacyColumn("txt", "Notes", "rich-text"),
    legacyColumn("ms", "Tags", "multi-select"),
    legacyColumn("prog", "Progress", "progress"),
    goodSelect,
    badNumber,
  ]);
  const rowCells = new Y.Map();
  block.get("prop:cells").set("row1", rowCells);
  const cell = new Y.Map();
  cell.set("columnId", "num");
  cell.set("value", 12.5);
  rowCells.set("num", cell);
  const cellsBefore = block.get("prop:cells").toJSON();

  const dry = repairDatabaseColumnsData(block, false);
  assert.deepEqual(dry.map(repair => repair.id), ["t", "num", "txt", "ms", "num2"]);
  assert.equal(yColumns.get(1).get("data"), undefined, "dry run must not write");

  const stateBefore = Y.encodeStateVector(doc);
  const applied = repairDatabaseColumnsData(block, true);
  assert.deepEqual(applied.map(repair => repair.status), ["missing", "missing", "missing", "missing", "invalid"]);
  assert.ok(Y.encodeStateAsUpdate(doc, stateBefore).length > 0);

  const dataById = Object.fromEntries(yColumns.toArray().map(column => [column.get("id"), column.get("data")]));
  assert.deepEqual(dataById.t.toJSON(), {});
  assert.deepEqual(dataById.num.toJSON(), { decimal: 0, format: "number" });
  assert.deepEqual(dataById.txt.toJSON(), {});
  assert.deepEqual(dataById.ms.toJSON(), { options: [] });
  assert.deepEqual(dataById.num2.toJSON(), { decimal: 0, format: "percent" }, "valid format kept, bad decimal reset");
  assert.equal(dataById.prog, undefined, "unsupported types are left alone");
  assert.equal(dataById.sel.get("options").length, 1, "valid select untouched");
  assert.deepEqual(block.get("prop:cells").toJSON(), cellsBefore, "cells untouched");

  assert.deepEqual(repairDatabaseColumnsData(block, true), [], "repair is idempotent");
}

// Plain-object columns (non-Yjs storage) are repaired in place.
{
  const doc = new Y.Doc();
  const block = doc.getMap("blocks").set("db", new Y.Map());
  const yColumns = new Y.Array();
  block.set("prop:columns", yColumns);
  yColumns.push([{ id: "p", name: "Price", type: "number" }]);
  const repairs = repairDatabaseColumnsData(block, true);
  assert.equal(repairs.length, 1);
  assert.deepEqual(yColumns.get(0), { id: "p", name: "Price", type: "number", data: { decimal: 0, format: "number" } });
}

console.log("database column data: ok");
