// graphql.ts — a hand-rolled GraphQL executor for the forge: a tokenizer and
// recursive-descent parser for the query/mutation subset the conformance
// client sends, an executor over the store, and the introspection schema
// (Query.__type / __schema) that gh's feature detection probes.

import { parseCommit } from './git.ts';
import { tsFor } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') {
        while (i < source.length && source[i] !== '\n') i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$[]=|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selection: SelectionNode[] };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected '${value}' but got ${token.kind} ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} but got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const op = this.expectName();
      if (op !== 'query' && op !== 'mutation' && op !== 'subscription') {
        throw new Error(`unsupported operation ${op}`);
      }
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables: OperationNode['variables'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          const type = this.parseType();
          let defaultValue: ValueNode | null = null;
          if (this.peek().kind === 'punct' && this.peek().value === '=') {
            this.next();
            defaultValue = this.parseValue();
          }
          variables.push({ name: varName, type, defaultValue });
        }
        this.expectPunct(')');
      }
      operations.push({ operation: op as 'query' | 'mutation', name, variables, selection: this.parseSelectionSet() });
    }
    return operations;
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          typeCondition = this.expectName();
        } else if (this.peek().kind === 'name') {
          throw new Error('named fragment spreads are not supported');
        }
        selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      let selection: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// the introspection schema
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  name: string;
  type: string;
  args?: Array<{ name: string; type: string }>;
}

interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE' | 'UNION';
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: FieldDef[];
  description?: string;
}

const SCHEMA: TypeDef[] = [
  { name: 'Query', kind: 'OBJECT', fields: [
    { name: 'viewer', type: 'User' },
    { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
    { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
    { name: '__schema', type: '__Schema!' },
    { name: '__type', type: '__Type', args: [{ name: 'name', type: 'String!' }] },
  ] },
  { name: 'Mutation', kind: 'OBJECT', fields: [
    { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
    { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
    { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
    { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
    { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
  ] },
  { name: 'Repository', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'databaseId', type: 'Int' },
    { name: 'name', type: 'String!' },
    { name: 'nameWithOwner', type: 'String!' },
    { name: 'description', type: 'String' },
    { name: 'isPrivate', type: 'Boolean!' },
    { name: 'isFork', type: 'Boolean!' },
    { name: 'owner', type: 'RepositoryOwner!' },
    { name: 'defaultBranchRef', type: 'Ref' },
    { name: 'viewerPermission', type: 'RepositoryPermission' },
    { name: 'hasIssuesEnabled', type: 'Boolean!' },
    { name: 'hasProjectsEnabled', type: 'Boolean!' },
    { name: 'hasWikiEnabled', type: 'Boolean!' },
    { name: 'issues', type: 'IssueConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'states', type: '[IssueState!]' }, { name: 'orderBy', type: 'IssueOrder' }] },
    { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
    { name: 'pullRequests', type: 'PullRequestConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'states', type: '[PullRequestState!]' }, { name: 'orderBy', type: 'IssueOrder' }] },
    { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
    { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    { name: 'createdAt', type: 'DateTime!' },
    { name: 'updatedAt', type: 'DateTime!' },
    { name: 'pushedAt', type: 'DateTime' },
    { name: 'url', type: 'URI!' },
    { name: 'sshUrl', type: 'URI!' },
    { name: 'forkCount', type: 'Int!' },
    { name: 'stargazerCount', type: 'Int!' },
    { name: 'watchers', type: 'UserConnection!' },
    { name: 'primaryLanguage', type: 'Language' },
    { name: 'licenseInfo', type: 'License' },
    { name: 'diskUsage', type: 'Int' },
  ] },
  { name: 'Issue', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'databaseId', type: 'Int' },
    { name: 'number', type: 'Int!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
    { name: 'bodyText', type: 'String!' },
    { name: 'state', type: 'IssueState!' },
    { name: 'stateReason', type: 'IssueStateReason' },
    { name: 'author', type: 'Actor' },
    { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    { name: 'comments', type: 'IssueCommentConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    { name: 'createdAt', type: 'DateTime!' },
    { name: 'updatedAt', type: 'DateTime!' },
    { name: 'closedAt', type: 'DateTime' },
    { name: 'url', type: 'URI!' },
    { name: 'repository', type: 'Repository!' },
    { name: 'locked', type: 'Boolean!' },
    { name: 'milestone', type: 'Milestone' },
    { name: 'assignees', type: 'UserConnection!' },
    { name: 'participants', type: 'UserConnection!' },
    { name: 'timelineItems', type: 'IssueTimelineItemsConnection!' },
  ] },
  { name: 'PullRequest', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'databaseId', type: 'Int' },
    { name: 'number', type: 'Int!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
    { name: 'state', type: 'PullRequestState!' },
    { name: 'merged', type: 'Boolean!' },
    { name: 'mergeable', type: 'MergeableState!' },
    { name: 'mergeStateStatus', type: 'MergeStateStatus' },
    { name: 'headRefName', type: 'String!' },
    { name: 'baseRefName', type: 'String!' },
    { name: 'headRef', type: 'Ref' },
    { name: 'baseRef', type: 'Ref' },
    { name: 'author', type: 'Actor' },
    { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    { name: 'files', type: 'PullRequestFileConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    { name: 'commits', type: 'PullRequestCommitConnection!' },
    { name: 'reviews', type: 'PullRequestReviewConnection' },
    { name: 'createdAt', type: 'DateTime!' },
    { name: 'updatedAt', type: 'DateTime!' },
    { name: 'closedAt', type: 'DateTime' },
    { name: 'mergedAt', type: 'DateTime' },
    { name: 'mergeCommit', type: 'Commit' },
    { name: 'url', type: 'URI!' },
    { name: 'repository', type: 'Repository!' },
    { name: 'isDraft', type: 'Boolean!' },
    { name: 'additions', type: 'Int!' },
    { name: 'deletions', type: 'Int!' },
    { name: 'changedFiles', type: 'Int!' },
  ] },
  { name: 'User', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'databaseId', type: 'Int' },
    { name: 'login', type: 'String!' },
    { name: 'name', type: 'String' },
    { name: 'avatarUrl', type: 'URI!' },
    { name: 'url', type: 'URI!' },
    { name: 'email', type: 'String' },
  ] },
  { name: 'Ref', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'name', type: 'String!' },
    { name: 'prefix', type: 'String!' },
    { name: 'target', type: 'GitObject' },
    { name: 'repository', type: 'Repository!' },
  ] },
  { name: 'Commit', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'oid', type: 'GitObjectID!' },
    { name: 'message', type: 'String!' },
    { name: 'messageHeadline', type: 'String!' },
    { name: 'author', type: 'GitActor' },
    { name: 'committer', type: 'GitActor' },
    { name: 'tree', type: 'Tree!' },
  ] },
  { name: 'GitActor', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String' },
    { name: 'email', type: 'String' },
    { name: 'date', type: 'DateTime' },
    { name: 'user', type: 'User' },
  ] },
  { name: 'Tree', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'oid', type: 'GitObjectID!' },
    { name: 'entries', type: '[TreeEntry!]!' },
  ] },
  { name: 'TreeEntry', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String!' },
    { name: 'type', type: 'String!' },
    { name: 'oid', type: 'GitObjectID!' },
    { name: 'mode', type: 'Int!' },
  ] },
  { name: 'Label', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'name', type: 'String!' },
    { name: 'color', type: 'String!' },
    { name: 'description', type: 'String' },
    { name: 'isDefault', type: 'Boolean!' },
    { name: 'url', type: 'URI!' },
  ] },
  { name: 'IssueComment', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'databaseId', type: 'Int' },
    { name: 'body', type: 'String!' },
    { name: 'bodyText', type: 'String!' },
    { name: 'author', type: 'Actor' },
    { name: 'createdAt', type: 'DateTime!' },
    { name: 'updatedAt', type: 'DateTime!' },
    { name: 'url', type: 'URI!' },
    { name: 'issue', type: 'Issue!' },
  ] },
  { name: 'PullRequestFile', kind: 'OBJECT', fields: [
    { name: 'path', type: 'String!' },
    { name: 'additions', type: 'Int!' },
    { name: 'deletions', type: 'Int!' },
    { name: 'changeType', type: 'PatchStatus!' },
  ] },
  { name: 'IssueConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[Issue]' },
    { name: 'edges', type: '[IssueEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'IssueEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'Issue' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'PullRequestConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[PullRequest]' },
    { name: 'edges', type: '[PullRequestEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'PullRequestEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'PullRequest' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'LabelConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[Label]' },
    { name: 'edges', type: '[LabelEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'LabelEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'Label' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'IssueCommentConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[IssueComment]' },
    { name: 'edges', type: '[IssueCommentEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'IssueCommentEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'IssueComment' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'PullRequestFileConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[PullRequestFile]' },
    { name: 'edges', type: '[PullRequestFileEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'PullRequestFileEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'PullRequestFile' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'PullRequestCommitConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[PullRequestCommit]' },
    { name: 'edges', type: '[PullRequestCommitEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'PullRequestCommit', kind: 'OBJECT', fields: [
    { name: 'commit', type: 'Commit!' },
  ] },
  { name: 'PullRequestCommitEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'PullRequestCommit' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'PullRequestReviewConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[PullRequestReview]' },
    { name: 'edges', type: '[PullRequestReviewEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'PullRequestReview', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'state', type: 'PullRequestReviewState!' },
    { name: 'author', type: 'Actor' },
    { name: 'body', type: 'String!' },
  ] },
  { name: 'PullRequestReviewEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'PullRequestReview' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'UserConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[User]' },
    { name: 'edges', type: '[UserEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'UserEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'User' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'IssueTimelineItemsConnection', kind: 'OBJECT', fields: [
    { name: 'totalCount', type: 'Int!' },
    { name: 'nodes', type: '[IssueTimelineItems]' },
    { name: 'edges', type: '[IssueTimelineItemsEdge]' },
    { name: 'pageInfo', type: 'PageInfo!' },
  ] },
  { name: 'IssueTimelineItemsEdge', kind: 'OBJECT', fields: [
    { name: 'node', type: 'IssueTimelineItems' },
    { name: 'cursor', type: 'String!' },
  ] },
  { name: 'PageInfo', kind: 'OBJECT', fields: [
    { name: 'hasNextPage', type: 'Boolean!' },
    { name: 'hasPreviousPage', type: 'Boolean!' },
    { name: 'startCursor', type: 'String' },
    { name: 'endCursor', type: 'String' },
  ] },
  { name: 'CreateIssuePayload', kind: 'OBJECT', fields: [
    { name: 'issue', type: 'Issue' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'CloseIssuePayload', kind: 'OBJECT', fields: [
    { name: 'issue', type: 'Issue' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'CreatePullRequestPayload', kind: 'OBJECT', fields: [
    { name: 'pullRequest', type: 'PullRequest' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'MergePullRequestPayload', kind: 'OBJECT', fields: [
    { name: 'pullRequest', type: 'PullRequest' },
    { name: 'actor', type: 'Actor' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'AddCommentPayload', kind: 'OBJECT', fields: [
    { name: 'commentEdge', type: 'IssueCommentEdge' },
    { name: 'subject', type: 'Node' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'Milestone', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'number', type: 'Int!' },
    { name: 'title', type: 'String!' },
  ] },
  { name: 'Language', kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'name', type: 'String!' },
  ] },
  { name: 'License', kind: 'OBJECT', fields: [
    { name: 'key', type: 'String!' },
    { name: 'name', type: 'String!' },
    { name: 'spdxId', type: 'String' },
  ] },
  { name: 'Node', kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] },
  { name: 'Actor', kind: 'INTERFACE', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'login', type: 'String!' },
    { name: 'avatarUrl', type: 'URI!' },
    { name: 'url', type: 'URI!' },
  ] },
  { name: 'RepositoryOwner', kind: 'INTERFACE', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'login', type: 'String!' },
    { name: 'avatarUrl', type: 'URI!' },
    { name: 'url', type: 'URI!' },
  ] },
  { name: 'GitObject', kind: 'INTERFACE', fields: [
    { name: 'id', type: 'ID!' },
    { name: 'oid', type: 'GitObjectID!' },
  ] },
  { name: 'IssueTimelineItems', kind: 'UNION', fields: [] },
  { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  { name: 'IssueStateReason', kind: 'ENUM', enumValues: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'] },
  { name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  { name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  { name: 'MergeStateStatus', kind: 'ENUM', enumValues: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'] },
  { name: 'RepositoryPermission', kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  { name: 'PatchStatus', kind: 'ENUM', enumValues: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'REMOVED', 'RENAMED'] },
  { name: 'PullRequestReviewState', kind: 'ENUM', enumValues: ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'] },
  { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'MARKETPLACE', 'TOPIC'] },
  { name: 'IssueOrderField', kind: 'ENUM', enumValues: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'] },
  { name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  { name: 'IssueOrder', kind: 'INPUT_OBJECT', inputFields: [
    { name: 'field', type: 'IssueOrderField!' },
    { name: 'direction', type: 'OrderDirection!' },
  ] },
  { name: 'CreateIssueInput', kind: 'INPUT_OBJECT', inputFields: [
    { name: 'repositoryId', type: 'ID!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'CloseIssueInput', kind: 'INPUT_OBJECT', inputFields: [
    { name: 'issueId', type: 'ID!' },
    { name: 'stateReason', type: 'IssueStateReason' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'CreatePullRequestInput', kind: 'INPUT_OBJECT', inputFields: [
    { name: 'repositoryId', type: 'ID!' },
    { name: 'baseRefName', type: 'String!' },
    { name: 'headRefName', type: 'String!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'MergePullRequestInput', kind: 'INPUT_OBJECT', inputFields: [
    { name: 'pullRequestId', type: 'ID!' },
    { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'AddCommentInput', kind: 'INPUT_OBJECT', inputFields: [
    { name: 'subjectId', type: 'ID!' },
    { name: 'body', type: 'String!' },
    { name: 'clientMutationId', type: 'String' },
  ] },
  { name: 'PullRequestMergeMethod', kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  { name: '__Schema', kind: 'OBJECT', fields: [
    { name: 'queryType', type: '__Type!' },
    { name: 'mutationType', type: '__Type' },
    { name: 'subscriptionType', type: '__Type' },
    { name: 'types', type: '[__Type!]!' },
    { name: 'directives', type: '[__Directive!]!' },
  ] },
  { name: '__Type', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String' },
    { name: 'kind', type: '__TypeKind!' },
    { name: 'description', type: 'String' },
    { name: 'fields', type: '[__Field!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
    { name: 'enumValues', type: '[__EnumValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
    { name: 'inputFields', type: '[__InputValue!]' },
    { name: 'interfaces', type: '[__Type!]' },
    { name: 'possibleTypes', type: '[__Type!]' },
    { name: 'ofType', type: '__Type' },
    { name: 'specifiedByURL', type: 'String' },
    { name: 'isOneOf', type: 'Boolean' },
  ] },
  { name: '__Field', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String!' },
    { name: 'description', type: 'String' },
    { name: 'args', type: '[__InputValue!]!' },
    { name: 'type', type: '__Type!' },
    { name: 'isDeprecated', type: 'Boolean!' },
    { name: 'deprecationReason', type: 'String' },
  ] },
  { name: '__InputValue', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String!' },
    { name: 'description', type: 'String' },
    { name: 'type', type: '__Type!' },
    { name: 'defaultValue', type: 'String' },
  ] },
  { name: '__EnumValue', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String!' },
    { name: 'description', type: 'String' },
    { name: 'isDeprecated', type: 'Boolean!' },
    { name: 'deprecationReason', type: 'String' },
  ] },
  { name: '__Directive', kind: 'OBJECT', fields: [
    { name: 'name', type: 'String!' },
    { name: 'description', type: 'String' },
    { name: 'locations', type: '[__DirectiveLocation!]!' },
    { name: 'args', type: '[__InputValue!]!' },
    { name: 'isRepeatable', type: 'Boolean!' },
  ] },
  { name: '__TypeKind', kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  { name: '__DirectiveLocation', kind: 'ENUM', enumValues: ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'VARIABLE_DEFINITION', 'SCHEMA', 'SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'INTERFACE', 'UNION', 'ENUM', 'ENUM_VALUE', 'INPUT_OBJECT', 'INPUT_FIELD_DEFINITION'] },
  { name: 'String', kind: 'SCALAR' },
  { name: 'Int', kind: 'SCALAR' },
  { name: 'Float', kind: 'SCALAR' },
  { name: 'Boolean', kind: 'SCALAR' },
  { name: 'ID', kind: 'SCALAR' },
  { name: 'DateTime', kind: 'SCALAR' },
  { name: 'URI', kind: 'SCALAR' },
  { name: 'GitObjectID', kind: 'SCALAR' },
];

const TYPE_MAP = new Map(SCHEMA.map((t) => [t.name, t]));

/** Render a type reference string (e.g. '[Issue!]!') as an introspection __Type object. */
function typeRef(type: string): Record<string, unknown> {
  if (type.endsWith('!')) {
    return { kind: 'NON_NULL', name: null, ofType: typeRef(type.slice(0, -1)) };
  }
  if (type.startsWith('[') && type.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: typeRef(type.slice(1, -1)) };
  }
  const def = TYPE_MAP.get(type);
  return { kind: def?.kind ?? 'SCALAR', name: type, ofType: null };
}

function globalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------------------------
// values the executor hands around
// ---------------------------------------------------------------------------------------------

interface GqlValue {
  __typename: string;
  [key: string]: unknown;
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function connectionValue(
  typename: string,
  items: GqlValue[],
  first: number | undefined,
  after: string | null | undefined,
): GqlValue {
  const total = items.length;
  const startIndex = indexFromCursor(after ?? null) + 1;
  const pageSize = first ?? total;
  const page = items.slice(startIndex, startIndex + pageSize);
  const endIndex = startIndex + page.length - 1;
  return {
    __typename: typename,
    __items: page,
    __total: total,
    __hasNext: endIndex + 1 < total,
    __hasPrev: startIndex > 0,
    __startCursor: page.length ? cursorFor(startIndex) : null,
    __endCursor: page.length ? cursorFor(endIndex) : null,
  };
}

function issueValue(store: Store, repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullValue(store: Store, repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function repoValue(store: Store, repo: Repo): GqlValue {
  return { __typename: 'Repository', __repo: repo };
}

function userValue(login: string): GqlValue {
  return { __typename: 'User', __login: login };
}

function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const out = [...issues];
  const order = (orderBy && typeof orderBy === 'object' ? orderBy as Record<string, unknown> : {}) as { field?: string; direction?: string };
  const field = order.field ?? 'CREATED_AT';
  const direction = order.direction ?? 'DESC';
  const key = (i: Issue): number => (field === 'UPDATED_AT' ? i.updatedSeq : field === 'COMMENTS' ? i.comments.length : i.createdSeq);
  // CREATED_AT DESC is number DESC; the creation sequence is the number order.
  out.sort((a, b) => (direction === 'ASC' ? key(a) - key(b) : key(b) - key(a)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function resolveField(exec: Executor, parent: GqlValue, field: FieldNode): unknown {
  const type = parent.__typename;
  const args = argMap(field, exec.variables);
  const store = exec.store;

  if (field.name === '__typename') return type;

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') {
        if (!store.viewer) return null;
        return userValue(store.viewer);
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = store.findRepo(owner, name);
        return repo ? repoValue(store, repo) : null;
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.repos.find((r) => r.id === parseInt(decoded.value, 10));
          return repo ? repoValue(store, repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const id = parseInt(decoded.value, 10);
          for (const repo of store.repos) {
            const issue = repo.issues.find((i) => i.id === id);
            if (issue) return issueValue(store, repo, issue);
          }
          return null;
        }
        if (decoded.kind === 'PullRequest') {
          const id = parseInt(decoded.value, 10);
          for (const repo of store.repos) {
            const pull = repo.pulls.find((p) => p.id === id);
            if (pull) return pullValue(store, repo, pull);
          }
          return null;
        }
        return null;
      }
      if (field.name === '__type') {
        const def = TYPE_MAP.get(String(args.name ?? ''));
        if (!def) return null;
        return { __typename: '__Type', __typeDef: def };
      }
      if (field.name === '__schema') {
        return { __typename: '__Schema' };
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'Repository') return { __typename: 'CreateIssuePayload', __issue: null };
        const repo = store.repos.find((r) => r.id === parseInt(decoded.value, 10));
        if (!repo) return { __typename: 'CreateIssuePayload', __issue: null };
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', __issue: issueValue(store, repo, issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'Issue') return { __typename: 'CloseIssuePayload', __issue: null };
        const id = parseInt(decoded.value, 10);
        for (const repo of store.repos) {
          const issue = repo.issues.find((i) => i.id === id);
          if (issue) {
            issue.state = 'closed';
            issue.updatedSeq = store.nextSeq();
            repo.issueJson.delete(issue.number);
            return { __typename: 'CloseIssuePayload', __issue: issueValue(store, repo, issue) };
          }
        }
        return { __typename: 'CloseIssuePayload', __issue: null };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'Repository') return { __typename: 'CreatePullRequestPayload', __pull: null };
        const repo = store.repos.find((r) => r.id === parseInt(decoded.value, 10));
        if (!repo) return { __typename: 'CreatePullRequestPayload', __pull: null };
        const pull = store.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        return { __typename: 'CreatePullRequestPayload', __pull: pull ? pullValue(store, repo, pull) : null };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'PullRequest') return { __typename: 'MergePullRequestPayload', __pull: null };
        const id = parseInt(decoded.value, 10);
        for (const repo of store.repos) {
          const pull = repo.pulls.find((p) => p.id === id);
          if (pull) {
            const sha = store.mergePull(repo, pull);
            if (!sha) {
              exec.errors.push({ message: `Pull request #${pull.number} cannot be merged` });
              return { __typename: 'MergePullRequestPayload', __pull: pullValue(store, repo, pull) };
            }
            return { __typename: 'MergePullRequestPayload', __pull: pullValue(store, repo, pull) };
          }
        }
        return { __typename: 'MergePullRequestPayload', __pull: null };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const body = String(input.body ?? '');
        if (!decoded) return { __typename: 'AddCommentPayload', __comment: null, __subject: null };
        if (decoded.kind === 'Issue') {
          const id = parseInt(decoded.value, 10);
          for (const repo of store.repos) {
            const issue = repo.issues.find((i) => i.id === id);
            if (issue) {
              const comment = { id: store.nextCommentId++, body, user: store.viewer ?? '', createdSeq: store.nextSeq() };
              issue.comments.push(comment);
              issue.updatedSeq = store.seq;
              repo.issueJson.delete(issue.number);
              return {
                __typename: 'AddCommentPayload',
                __comment: { __typename: 'IssueComment', __comment: comment, __issue: issue, __repo: repo },
                __subject: issueValue(store, repo, issue),
              };
            }
          }
        }
        if (decoded.kind === 'PullRequest') {
          const id = parseInt(decoded.value, 10);
          for (const repo of store.repos) {
            const pull = repo.pulls.find((p) => p.id === id);
            if (pull) {
              const comment = { id: store.nextCommentId++, body, user: store.viewer ?? '', createdSeq: store.nextSeq() };
              pull.comments.push(comment);
              pull.updatedSeq = store.seq;
              return {
                __typename: 'AddCommentPayload',
                __comment: { __typename: 'IssueComment', __comment: comment, __pull: pull, __repo: repo },
                __subject: pullValue(store, repo, pull),
              };
            }
          }
        }
        return { __typename: 'AddCommentPayload', __comment: null, __subject: null };
      }
      break;
    }
    case 'Repository': {
      const repo = parent.__repo as Repo;
      const owner = store.repoOwner(repo);
      switch (field.name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${owner}/${repo.name}`;
        case 'description': return repo.description || null;
        case 'isPrivate': return repo.private;
        case 'isFork': return false;
        case 'owner': return userValue(owner);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return { __typename: 'Ref', __name: repo.defaultBranch, __repo: repo };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasProjectsEnabled': return false;
        case 'hasWikiEnabled': return false;
        case 'issues': {
          let items = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (states && states.length) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            items = items.filter((i) => wanted.has(i.state));
          }
          items = orderIssues(items, args.orderBy);
          return connectionValue(
            'IssueConnection',
            items.map((i) => issueValue(store, repo, i)),
            typeof args.first === 'number' ? args.first : undefined,
            typeof args.after === 'string' ? args.after : null,
          );
        }
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === args.number);
          return issue ? issueValue(store, repo, issue) : null;
        }
        case 'pullRequests': {
          let items = [...repo.pulls];
          const states = args.states as string[] | undefined;
          if (states && states.length) {
            const wanted = new Set(states.map((s) => s.toUpperCase()));
            items = items.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
          }
          items.sort((a, b) => b.createdSeq - a.createdSeq);
          return connectionValue(
            'PullRequestConnection',
            items.map((p) => pullValue(store, repo, p)),
            typeof args.first === 'number' ? args.first : undefined,
            typeof args.after === 'string' ? args.after : null,
          );
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === args.number);
          return pull ? pullValue(store, repo, pull) : null;
        }
        case 'labels': {
          return connectionValue(
            'LabelConnection',
            repo.labels.map((l) => ({ __typename: 'Label', __label: l })),
            typeof args.first === 'number' ? args.first : undefined,
            typeof args.after === 'string' ? args.after : null,
          );
        }
        case 'createdAt': return tsFor(repo.createdSeq);
        case 'updatedAt': return tsFor(repo.createdSeq);
        case 'pushedAt': return tsFor(repo.createdSeq);
        case 'url': return `https://github.com/${owner}/${repo.name}`;
        case 'sshUrl': return `git@github.com:${owner}/${repo.name}.git`;
        case 'forkCount': return 0;
        case 'stargazerCount': return 0;
        case 'watchers': return connectionValue('UserConnection', [], undefined, null);
        case 'primaryLanguage': return null;
        case 'licenseInfo': return null;
        case 'diskUsage': return 0;
        default: break;
      }
      break;
    }
    case 'Issue': {
      const issue = parent.__issue as Issue;
      const repo = parent.__repo as Repo;
      switch (field.name) {
        case 'id': return globalId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'stateReason': return issue.state === 'closed' ? 'COMPLETED' : null;
        case 'author': return userValue(issue.user || store.repoOwner(repo));
        case 'labels': return connectionValue(
          'LabelConnection',
          issue.labels.map((l) => ({ __typename: 'Label', __label: l })),
          typeof args.first === 'number' ? args.first : undefined,
          typeof args.after === 'string' ? args.after : null,
        );
        case 'comments': return connectionValue(
          'IssueCommentConnection',
          issue.comments.map((c) => ({ __typename: 'IssueComment', __comment: c, __issue: issue, __repo: repo })),
          typeof args.first === 'number' ? args.first : undefined,
          typeof args.after === 'string' ? args.after : null,
        );
        case 'createdAt': return tsFor(issue.createdSeq);
        case 'updatedAt': return tsFor(issue.updatedSeq);
        case 'closedAt': return issue.state === 'closed' ? tsFor(issue.updatedSeq) : null;
        case 'url': return `https://github.com/${store.repoOwner(repo)}/${repo.name}/issues/${issue.number}`;
        case 'repository': return repoValue(store, repo);
        case 'locked': return false;
        case 'milestone': return null;
        case 'assignees': return connectionValue('UserConnection', [], undefined, null);
        case 'participants': return connectionValue('UserConnection', [], undefined, null);
        case 'timelineItems': return connectionValue('IssueTimelineItemsConnection', [], undefined, null);
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const pull = parent.__pull as Pull;
      const repo = parent.__repo as Repo;
      switch (field.name) {
        case 'id': return globalId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return store.mergeable(pull, repo) ? 'MERGEABLE' : 'CONFLICTING';
        case 'mergeStateStatus': return store.mergeable(pull, repo) ? 'CLEAN' : 'DIRTY';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __typename: 'Ref', __name: pull.headRef, __repo: repo };
        case 'baseRef': return { __typename: 'Ref', __name: pull.baseRef, __repo: repo };
        case 'author': return userValue(pull.user || store.repoOwner(repo));
        case 'labels': return connectionValue('LabelConnection', [], undefined, null);
        case 'files': {
          const baseTip = store.resolveRef(repo, pull.baseRef);
          const baseCommit = baseTip ? repo.objects.get(baseTip) : undefined;
          const headCommit = repo.objects.get(pull.headSha);
          if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') {
            return connectionValue('PullRequestFileConnection', [], undefined, null);
          }
          const files = store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
          return connectionValue(
            'PullRequestFileConnection',
            files.map((f) => ({
              __typename: 'PullRequestFile',
              __path: f.filename,
              __additions: f.additions,
              __deletions: f.deletions,
              __changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
            })),
            typeof args.first === 'number' ? args.first : undefined,
            typeof args.after === 'string' ? args.after : null,
          );
        }
        case 'commits': {
          const commits = store.commitsFrom(repo, pull.headSha);
          const baseTip = store.resolveRef(repo, pull.baseRef);
          const baseSet = new Set(store.commitsFrom(repo, baseTip ?? '').map((c) => c.oid));
          const unique = commits.filter((c) => !baseSet.has(c.oid));
          return connectionValue(
            'PullRequestCommitConnection',
            unique.map((c) => ({ __typename: 'PullRequestCommit', __commitOid: c.oid, __repo: repo })),
            typeof args.first === 'number' ? args.first : undefined,
            typeof args.after === 'string' ? args.after : null,
          );
        }
        case 'reviews': return connectionValue('PullRequestReviewConnection', [], undefined, null);
        case 'createdAt': return tsFor(pull.createdSeq);
        case 'updatedAt': return tsFor(pull.updatedSeq);
        case 'closedAt': return pull.state === 'closed' ? tsFor(pull.updatedSeq) : null;
        case 'mergedAt': return pull.merged_at;
        case 'mergeCommit': {
          if (!pull.merge_commit_sha) return null;
          return { __typename: 'Commit', __oid: pull.merge_commit_sha, __repo: repo };
        }
        case 'url': return `https://github.com/${store.repoOwner(repo)}/${repo.name}/pull/${pull.number}`;
        case 'repository': return repoValue(store, repo);
        case 'isDraft': return false;
        case 'additions': {
          const files = pullFiles(store, repo, pull);
          return files.reduce((sum, f) => sum + f.additions, 0);
        }
        case 'deletions': {
          const files = pullFiles(store, repo, pull);
          return files.reduce((sum, f) => sum + f.deletions, 0);
        }
        case 'changedFiles': {
          const files = pullFiles(store, repo, pull);
          return files.length;
        }
        default: break;
      }
      break;
    }
    case 'User': {
      const login = parent.__login as string;
      switch (field.name) {
        case 'id': return globalId('User', login);
        case 'databaseId': return 1;
        case 'login': return login;
        case 'name': return login;
        case 'avatarUrl': return '';
        case 'url': return `https://github.com/${login}`;
        case 'email': return null;
        default: break;
      }
      break;
    }
    case 'Ref': {
      switch (field.name) {
        case 'id': return globalId('Ref', `${(parent.__repo as Repo).id}:${parent.__name as string}`);
        case 'name': return parent.__name as string;
        case 'prefix': return 'refs/heads/';
        case 'target': return null;
        case 'repository': return repoValue(store, parent.__repo as Repo);
        default: break;
      }
      break;
    }
    case 'Commit': {
      switch (field.name) {
        case 'id': return globalId('Commit', parent.__oid as string);
        case 'oid': return parent.__oid as string;
        case 'message': return '';
        case 'messageHeadline': return '';
        case 'author': return null;
        case 'committer': return null;
        case 'tree': return { __typename: 'Tree', __oid: '', __repo: parent.__repo as Repo };
        default: break;
      }
      break;
    }
    case 'Tree': {
      switch (field.name) {
        case 'id': return globalId('Tree', parent.__oid as string);
        case 'oid': return parent.__oid as string;
        case 'entries': return [];
        default: break;
      }
      break;
    }
    case 'Label': {
      const label = parent.__label as { id: number; name: string; color: string; description: string };
      switch (field.name) {
        case 'id': return globalId('Label', label.id);
        case 'name': return label.name;
        case 'color': return label.color;
        case 'description': return label.description || null;
        case 'isDefault': return false;
        case 'url': return '';
        default: break;
      }
      break;
    }
    case 'IssueComment': {
      const comment = parent.__comment as { id: number; body: string; user: string; createdSeq: number };
      switch (field.name) {
        case 'id': return globalId('IssueComment', comment.id);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'bodyText': return comment.body;
        case 'author': return userValue(comment.user || store.viewer || '');
        case 'createdAt': return tsFor(comment.createdSeq);
        case 'updatedAt': return tsFor(comment.createdSeq);
        case 'url': return '';
        case 'issue': {
          const issue = parent.__issue as Issue | undefined;
          if (!issue) return null;
          return issueValue(store, parent.__repo as Repo, issue);
        }
        default: break;
      }
      break;
    }
    case 'PullRequestFile': {
      switch (field.name) {
        case 'path': return parent.__path as string;
        case 'additions': return parent.__additions as number;
        case 'deletions': return parent.__deletions as number;
        case 'changeType': return parent.__changeType as string;
        default: break;
      }
      break;
    }
    case 'PullRequestCommit': {
      if (field.name === 'commit') {
        return { __typename: 'Commit', __oid: parent.__commitOid as string, __repo: parent.__repo as Repo };
      }
      break;
    }
    case 'PullRequestReview': {
      switch (field.name) {
        case 'id': return '';
        case 'state': return 'COMMENTED';
        case 'author': return null;
        case 'body': return '';
        default: break;
      }
      break;
    }
    case 'Milestone': {
      if (field.name === 'id') return '';
      if (field.name === 'number') return 0;
      if (field.name === 'title') return '';
      break;
    }
    case 'Language': {
      if (field.name === 'id') return '';
      if (field.name === 'name') return '';
      break;
    }
    case 'License': {
      if (field.name === 'key') return '';
      if (field.name === 'name') return '';
      if (field.name === 'spdxId') return null;
      break;
    }
    case 'GitActor': {
      if (field.name === 'name') return null;
      if (field.name === 'email') return null;
      if (field.name === 'date') return null;
      if (field.name === 'user') return null;
      break;
    }
    default: break;
  }

  // Connection types: nodes / edges / pageInfo / totalCount.
  if (type.endsWith('Connection')) {
    const items = (parent.__items ?? []) as GqlValue[];
    switch (field.name) {
      case 'totalCount': return parent.__total as number;
      case 'nodes': return items;
      case 'edges': return items.map((node, i) => ({ __typename: type.replace('Connection', 'Edge'), __node: node, __cursor: cursorFor(i) }));
      case 'pageInfo': return {
        __typename: 'PageInfo',
        __hasNext: parent.__hasNext as boolean,
        __hasPrev: parent.__hasPrev as boolean,
        __startCursor: parent.__startCursor as string | null,
        __endCursor: parent.__endCursor as string | null,
      };
      default: break;
    }
  }
  if (type.endsWith('Edge')) {
    if (field.name === 'node') return parent.__node as GqlValue;
    if (field.name === 'cursor') return parent.__cursor as string;
  }
  if (type === 'PageInfo') {
    switch (field.name) {
      case 'hasNextPage': return parent.__hasNext as boolean;
      case 'hasPreviousPage': return parent.__hasPrev as boolean;
      case 'startCursor': return parent.__startCursor as string | null;
      case 'endCursor': return parent.__endCursor as string | null;
      default: break;
    }
  }

  // Payload types.
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') return (parent.__issue as GqlValue | null) ?? null;
    if (field.name === 'clientMutationId') return null;
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return (parent.__pull as GqlValue | null) ?? null;
    if (field.name === 'actor') return store.viewer ? userValue(store.viewer) : null;
    if (field.name === 'clientMutationId') return null;
  }
  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const comment = parent.__comment as GqlValue | null;
      if (!comment) return null;
      return { __typename: 'IssueCommentEdge', __node: comment, __cursor: cursorFor(0) };
    }
    if (field.name === 'subject') return (parent.__subject as GqlValue | null) ?? null;
    if (field.name === 'clientMutationId') return null;
  }

  // Introspection types.
  if (type === '__Type') {
    const def = parent.__typeDef as TypeDef;
    switch (field.name) {
      case 'name': return def.name;
      case 'kind': return def.kind;
      case 'description': return def.description ?? null;
      case 'fields': {
        if (!def.fields) return null;
        return def.fields.map((f) => ({ __typename: '__Field', __fieldDef: f }));
      }
      case 'enumValues': {
        if (!def.enumValues) return null;
        return def.enumValues.map((name) => ({ __typename: '__EnumValue', __enumName: name }));
      }
      case 'inputFields': {
        if (!def.inputFields) return null;
        return def.inputFields.map((f) => ({ __typename: '__InputValue', __fieldDef: f }));
      }
      case 'interfaces': return [];
      case 'possibleTypes': return [];
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      case 'isOneOf': return false;
      default: break;
    }
  }
  if (type === '__Field') {
    const def = parent.__fieldDef as FieldDef;
    switch (field.name) {
      case 'name': return def.name;
      case 'description': return null;
      case 'args': return (def.args ?? []).map((a) => ({ __typename: '__InputValue', __fieldDef: a }));
      case 'type': return { __typename: '__Type', __typeRef: typeRef(def.type) };
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
  }
  if (type === '__InputValue') {
    const def = parent.__fieldDef as FieldDef;
    switch (field.name) {
      case 'name': return def.name;
      case 'description': return null;
      case 'type': return { __typename: '__Type', __typeRef: typeRef(def.type) };
      case 'defaultValue': return null;
      default: break;
    }
  }
  if (type === '__EnumValue') {
    switch (field.name) {
      case 'name': return parent.__enumName as string;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: break;
    }
  }
  if (type === '__Schema') {
    switch (field.name) {
      case 'queryType': return { __typename: '__Type', __typeDef: TYPE_MAP.get('Query')! };
      case 'mutationType': return { __typename: '__Type', __typeDef: TYPE_MAP.get('Mutation')! };
      case 'subscriptionType': return null;
      case 'types': return SCHEMA.map((def) => ({ __typename: '__Type', __typeDef: def }));
      case 'directives': return [];
      default: break;
    }
  }
  if (type === '__Directive') {
    switch (field.name) {
      case 'name': return '';
      case 'description': return null;
      case 'locations': return [];
      case 'args': return [];
      case 'isRepeatable': return false;
      default: break;
    }
  }

  // Unknown field on a known type.
  exec.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
  return null;
}

function pullFiles(store: Store, repo: Repo, pull: Pull): Array<{ additions: number; deletions: number }> {
  const baseTip = store.resolveRef(repo, pull.baseRef);
  const baseCommit = baseTip ? repo.objects.get(baseTip) : undefined;
  const headCommit = repo.objects.get(pull.headSha);
  if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return [];
  return store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function executeSelection(
  exec: Executor,
  parent: GqlValue,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== parent.__typename) continue;
      const sub = executeSelection(exec, parent, selection.selection);
      Object.assign(out, sub);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(exec, parent, field);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (typeof value === 'object' && field.selection) {
      if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (item && typeof item === 'object' && '__typename' in item) {
            return executeSelection(exec, item as GqlValue, field.selection!);
          }
          return item;
        });
      } else if ('__typename' in (value as Record<string, unknown>)) {
        out[key] = executeSelection(exec, value as GqlValue, field.selection);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface GraphqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one parsed operation against the store. */
export function executeGraphql(
  store: Store,
  operation: OperationNode,
  variables: Record<string, unknown>,
): GraphqlResult {
  const exec: Executor = { store, variables, errors: [] };
  const root: GqlValue = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  try {
    const data = executeSelection(exec, root, operation.selection);
    const result: GraphqlResult = { data };
    if (exec.errors.length) result.errors = exec.errors;
    return result;
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
}

/** Parse and execute a GraphQL request body (single operation or a batch array). */
export function handleGraphqlBody(store: Store, body: Buffer): { status: number; payload: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, payload: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: unknown[] = [];
  for (const request of requests) {
    const rec = request as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = (rec.variables && typeof rec.variables === 'object' ? rec.variables : {}) as Record<string, unknown>;
    const operationName = typeof rec.operationName === 'string' ? rec.operationName : null;
    if (!query) {
      responses.push({ data: null, errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      responses.push({ data: null, errors: [{ message: (err as Error).message }] });
      continue;
    }
    const operation = operationName
      ? operations.find((op) => op.name === operationName) ?? operations[0]
      : operations[0];
    if (!operation) {
      responses.push({ data: null, errors: [{ message: 'Must provide an operation.' }] });
      continue;
    }
    // Fill variable defaults.
    const vars = { ...variables };
    for (const v of operation.variables) {
      if (vars[v.name] === undefined && v.defaultValue) vars[v.name] = evalValue(v.defaultValue, vars);
    }
    responses.push(executeGraphql(store, operation, vars));
  }
  return { status: 200, payload: Array.isArray(parsed) ? responses : responses[0] };
}
