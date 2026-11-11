import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { FileTreeSearchResponse, Project } from '@/shared/types';

export type MentionableFile = {
  name: string;
  // Project-relative path, inserted into the message.
  path: string;
  // Absolute path on the server.
  relativePath?: string;
};

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

// The dropdown shows this many files; a few more are requested so ranking on
// the server, not truncation, decides which ones.
const MAXIMUM_SUGGESTIONS = 10;
const SEARCH_LIMIT = 20;
// Waits for a pause in typing so each keystroke does not cost a request.
const SEARCH_DEBOUNCE_MS = 100;

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const projectId = selectedProject?.projectId;
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  // The latest suggestions and the project they came from, so a project switch
  // never shows the previous project's files.
  const [suggestions, setSuggestions] = useState<{ projectId?: string; files: MentionableFile[] }>({ files: [] });
  const filteredFiles = useMemo(
    () => (suggestions.projectId === projectId ? suggestions.files : []),
    [suggestions, projectId],
  );
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  // The text typed after the active `@`, which the server searches for.
  const [mentionQuery, setMentionQuery] = useState('');
  // The search still in flight. Starting a new one aborts it, so an older
  // response can never overwrite a newer list.
  const fileSearchRequestRef = useRef<AbortController | null>(null);

  // Searching on the server each time the query settles keeps every file of a
  // large project reachable and picks up files created since the last `@`.
  useEffect(() => {
    if (!showFileDropdown || !projectId) {
      return undefined;
    }
    const timer = setTimeout(() => {
      fileSearchRequestRef.current?.abort();
      const abortController = new AbortController();
      fileSearchRequestRef.current = abortController;
      void (async () => {
        try {
          const response = await api.searchFiles(
            projectId,
            { query: mentionQuery, limit: SEARCH_LIMIT, type: 'file' },
            { signal: abortController.signal },
          );
          if (!response.ok || abortController.signal.aborted) {
            return;
          }
          const body = (await response.json()) as FileTreeSearchResponse;
          if (abortController.signal.aborted) {
            return;
          }
          setSuggestions({
            projectId,
            files: body.results.slice(0, MAXIMUM_SUGGESTIONS).map((match) => ({
              name: match.name,
              path: match.relativePath,
              relativePath: match.path,
            })),
          });
          setSelectedFileIndex(-1);
        } catch (error) {
          // Aborts come from newer searches and project switches.
          if ((error as { name?: string })?.name === 'AbortError') {
            return;
          }
          console.error('Error searching files:', error);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [showFileDropdown, projectId, mentionQuery]);

  useEffect(() => () => fileSearchRequestRef.current?.abort(), []);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    // Any whitespace ends the query, a line break as much as a space.
    if (/\s/.test(textAfterAt)) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);
    setMentionQuery(textAfterAt);
  }, [input, cursorPosition]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const whitespaceIndex = textAfterAtQuery.search(/\s/);
      const textAfterQuery = whitespaceIndex !== -1 ? textAfterAtQuery.slice(whitespaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The caret is still inside the `@` query; a search landing after this
        // would refill the closed list. Drop it; typing again searches again.
        fileSearchRequestRef.current?.abort();
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
