/**
 * Gemini API Core Logic
 *
 * Gemini File Search API와 상호작용하는 핵심 로직
 * - TypeScript로 완전히 재작성
 * - Type-safe API 호출
 * - 재시도 로직 및 캐싱 포함
 */

import { GoogleGenAI } from "@google/genai";
import type {
  FileSearchStore,
  FileSearchDocument,
  QueryResponse,
  UploadOptions,
  Operation,
} from "@/types";

// ============================================
// Constants
// ============================================

/**
 * File Search Store 이름 프리픽스
 * 모든 스토어는 "fileSearchStores/" 프리픽스를 가집니다
 */
const STORE_PREFIX = "fileSearchStores/";

// ============================================
// Utility Functions for Store Names
// ============================================

/**
 * 스토어 전체 이름에서 ID 추출
 * @param fullName - "fileSearchStores/test-aec0gqdpt7m4" 형식의 전체 이름
 * @returns "test-aec0gqdpt7m4" 형식의 ID
 */
export function extractStoreId(fullName: string): string {
  if (fullName.startsWith(STORE_PREFIX)) {
    return fullName.substring(STORE_PREFIX.length);
  }
  return fullName;
}

/**
 * 스토어 ID로 전체 이름 생성
 * @param storeId - "test-aec0gqdpt7m4" 형식의 ID
 * @returns "fileSearchStores/test-aec0gqdpt7m4" 형식의 전체 이름
 */
export function getFullStoreName(storeId: string): string {
  if (storeId.startsWith(STORE_PREFIX)) {
    return storeId;
  }
  return STORE_PREFIX + storeId;
}

// ============================================
// Client Initialization
// ============================================

/**
 * GoogleGenAI 클라이언트 초기화
 * API 키는 필수입니다
 */
const getGeminiClient = (apiKey: string) => {
  if (!apiKey) {
    throw new Error("API 키가 필요합니다. API 키를 입력해주세요.");
  }

  return new GoogleGenAI({ apiKey });
};

/**
 * API 키를 받아서 GoogleGenAI 클라이언트 반환
 * 매번 새로운 인스턴스 생성 (사용자별 API 키 지원)
 */
export const getAI = (apiKey: string): GoogleGenAI => {
  return getGeminiClient(apiKey);
};

// ============================================
// Utility Functions
// ============================================

/**
 * 재시도 로직을 포함한 비동기 함수 실행
 *
 * @param fn - 실행할 비동기 함수
 * @param maxRetries - 최대 재시도 횟수 (기본값: 3)
 * @param baseDelay - 기본 대기 시간(ms) (기본값: 1000)
 * @returns 함수 실행 결과
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error.status || error.statusCode;
      const isRetriableError =
        status === 429 || status === 503 || status === 500;

      if (attempt < maxRetries && isRetriableError) {
        const delay = baseDelay * Math.pow(2, attempt); // 지수 백오프
        console.log(
          `재시도 ${attempt + 1}/${maxRetries} - ${delay}ms 후 재시도...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  throw new Error("Maximum retries exceeded");
}

// ============================================
// File Search Store Management
// ============================================

/**
 * File Search Store 생성
 *
 * @param displayName - 스토어의 표시 이름
 * @param apiKey - Gemini API 키 (필수)
 * @returns 생성된 스토어 정보
 */
export async function createFileSearchStore(
  displayName: string,
  apiKey: string
): Promise<FileSearchStore> {
  console.log(`\n📦 파일 검색 스토어 생성 중: ${displayName}`);

  const ai = getAI(apiKey);
  const createStoreOp = await ai.fileSearchStores.create({
    config: { displayName },
  });

  console.log(`✅ 스토어가 생성되었습니다: ${createStoreOp.name}`);

  if (!createStoreOp.name) {
    throw new Error("Failed to create store: Name is missing");
  }

  // ID만 추출하여 저장
  const storeId = extractStoreId(createStoreOp.name);

  const activeDocumentsCountRaw =
    (createStoreOp as any).activeDocumentsCount ??
    (createStoreOp as any).activeDocumentCount ??
    0;
  const sizeBytesRaw = (createStoreOp as any).sizeBytes ?? 0;

  const store: FileSearchStore = {
    name: storeId,
    displayName: createStoreOp.displayName || displayName,
    activeDocumentsCount:
      typeof activeDocumentsCountRaw === "string"
        ? parseInt(activeDocumentsCountRaw)
        : activeDocumentsCountRaw || 0,
    sizeBytes:
      typeof sizeBytesRaw === "string"
        ? parseInt(sizeBytesRaw)
        : sizeBytesRaw || 0,
    createTime: createStoreOp.createTime || new Date().toISOString(),
    updateTime: createStoreOp.updateTime || new Date().toISOString(),
  };

  return store;
}

/**
 * Display Name으로 Store 찾기
 *
 * @param displayName - 찾을 스토어의 표시 이름
 * @param apiKey - Gemini API 키 (필수)
 * @returns 찾은 스토어 정보
 * @throws 스토어를 찾을 수 없을 경우
 */
export async function findStoreByDisplayName(
  displayName: string,
  apiKey: string
): Promise<FileSearchStore> {
  console.log(`\n🔍 스토어 검색 중: ${displayName}`);

  const ai = getAI(apiKey);
  let fileStore: FileSearchStore | null = null;
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 10 } });
  const page = pager.page;

  for (const store of page) {
    if (store.displayName === displayName && store.name) {
      // ID만 추출하여 저장
      const storeId = extractStoreId(store.name);

      const activeDocumentsCountRaw =
        (store as any).activeDocumentsCount ??
        (store as any).activeDocumentCount ??
        0;
      const sizeBytesRaw = (store as any).sizeBytes ?? 0;

      fileStore = {
        name: storeId,
        displayName: store.displayName,
        activeDocumentsCount:
          typeof activeDocumentsCountRaw === "string"
            ? parseInt(activeDocumentsCountRaw)
            : activeDocumentsCountRaw || 0,
        sizeBytes:
          typeof sizeBytesRaw === "string"
            ? parseInt(sizeBytesRaw)
            : sizeBytesRaw || 0,
        createTime: store.createTime || new Date().toISOString(),
        updateTime: store.updateTime || new Date().toISOString(),
      };
      break;
    }
  }

  if (!fileStore) {
    throw new Error(`'${displayName}' 이름의 스토어를 찾을 수 없습니다.`);
  }

  console.log(`✅ 스토어를 찾았습니다: ${fileStore.name}`);

  return fileStore;
}

/**
 * 모든 File Search Store 목록 조회
 *
 * @param apiKey - Gemini API 키 (필수)
 * @returns 스토어 목록
 */
export async function listAllStores(
  apiKey: string
): Promise<FileSearchStore[]> {
  const ai = getAI(apiKey);
  const stores: FileSearchStore[] = [];
  const pager = await ai.fileSearchStores.list({ config: { pageSize: 20 } });
  const page = pager.page;

  for (const store of page) {
    if (store.name && store.displayName) {
      // ID만 추출하여 저장
      const storeId = extractStoreId(store.name);

      const activeDocumentsCountRaw =
        (store as any).activeDocumentsCount ??
        (store as any).activeDocumentCount ??
        0;
      const sizeBytesRaw = (store as any).sizeBytes ?? 0;

      stores.push({
        name: storeId,
        displayName: store.displayName,
        activeDocumentsCount:
          typeof activeDocumentsCountRaw === "string"
            ? parseInt(activeDocumentsCountRaw)
            : activeDocumentsCountRaw || 0,
        sizeBytes:
          typeof sizeBytesRaw === "string"
            ? parseInt(sizeBytesRaw)
            : sizeBytesRaw || 0,
        createTime: store.createTime || new Date().toISOString(),
        updateTime: store.updateTime || new Date().toISOString(),
      });
    }
  }

  console.log(`✅ ${stores.length}개의 스토어를 찾았습니다`);

  return stores;
}

/**
 * File Search Store 삭제
 *
 * @param fileStore - 삭제할 스토어 객체
 * @param apiKey - Gemini API 키 (필수)
 */
export async function deleteFileSearchStore(
  fileStore: FileSearchStore,
  apiKey: string
): Promise<void> {
  console.log(`\n🗑️  파일 검색 스토어 삭제 중: ${fileStore.displayName}`);

  const ai = getAI(apiKey);

  // API 호출 시 전체 이름 사용
  const fullStoreName = getFullStoreName(fileStore.name);
  await ai.fileSearchStores.delete({
    name: fullStoreName,
    config: { force: true },
  });

  console.log(`✅ 스토어가 성공적으로 삭제되었습니다`);
}

// ============================================
// File Upload Functions
// ============================================

/**
 * 파일 MIME 타입 자동 감지
 */
function getMimeType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();

  const mimeMap: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".text": "text/plain",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  return mimeMap[ext] || "application/octet-stream";
}

function normalizeMimeType(mimeType?: string | null): string | undefined {
  const normalizedMimeType = mimeType?.trim().split(";")[0]?.trim();

  if (!normalizedMimeType) {
    return undefined;
  }

  const mimeTypePattern =
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

  return mimeTypePattern.test(normalizedMimeType)
    ? normalizedMimeType.toLowerCase()
    : undefined;
}

/**
 * 커스텀 청킹 전략으로 파일 업로드
 *
 * @param fileStore - 업로드할 대상 스토어 객체
 * @param file - 업로드할 파일 (경로 문자열 또는 Uint8Array/Buffer)
 * @param options - 업로드 옵션
 * @param apiKey - Gemini API 키 (필수)
 * @returns 업로드 완료된 operation 결과
 */
export async function uploadWithCustomChunking(
  fileStore: FileSearchStore,
  file: string | Uint8Array,
  options: UploadOptions = {},
  apiKey: string
): Promise<Operation> {
  const isFilePath = typeof file === "string";

  // displayName 결정: options에 있으면 사용, 없으면 기본값
  const displayName =
    options.displayName ||
    (isFilePath ? file.substring(file.lastIndexOf("/") + 1) : "file");

  const {
    customMetadata = [],
    maxTokensPerChunk = 500,
    maxOverlapTokens = 50,
    mimeType,
  } = options;

  console.log(`\n📄 커스텀 청킹으로 업로드 중: ${displayName}`);

  const fallbackMimeType = isFilePath
    ? getMimeType(file)
    : getMimeType(displayName);
  const resolvedMimeType =
    normalizeMimeType(mimeType) ||
    normalizeMimeType(fallbackMimeType) ||
    "application/octet-stream";

  const ai = getAI(apiKey); 

  const fileInput: string | Blob = isFilePath
    ? file
    : new Blob([file as any], { type: resolvedMimeType });
  const uploadConfig: {
    displayName: string;
    customMetadata: typeof customMetadata;
    chunkingConfig: {
      whiteSpaceConfig: {
        maxTokensPerChunk: number;
        maxOverlapTokens: number;
      };
    };
    mimeType?: string;
  } = {
    displayName,
    customMetadata,
    chunkingConfig: {
      whiteSpaceConfig: {
        maxTokensPerChunk,
        maxOverlapTokens,
      },
    },
  };

  if (isFilePath) {
    uploadConfig.mimeType = resolvedMimeType;
  }

  // API 호출 시 전체 이름 사용
  const fullStoreName = getFullStoreName(fileStore.name);

  // 재시도 로직 적용하여 업로드
  let advancedUploadOp = await retryWithBackoff(async () => {
    return await ai.fileSearchStores.uploadToFileSearchStore({
      file: fileInput,
      fileSearchStoreName: fullStoreName,
      config: uploadConfig,
    });
  });

  // 파일 처리 완료까지 폴링 (1초마다 상태 확인, 최대 5분)
  const maxPollAttempts = 300; // 5분
  let pollAttempts = 0;

  while (!advancedUploadOp.done && pollAttempts < maxPollAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    advancedUploadOp = await ai.operations.get({ operation: advancedUploadOp });
    pollAttempts++;
  }

  if (!advancedUploadOp.done) {
    throw new Error(`파일 처리 시간 초과: ${displayName}`);
  }

  console.log(`✅ 고급 파일 처리 완료: ${displayName}`);

  return advancedUploadOp as Operation;
}

// ============================================
// RAG Query Function
// ============================================

/**
 * File Search를 사용한 생성 쿼리 (RAG)
 *
 * @param fileStore - 검색할 스토어 객체
 * @param query - 사용자의 질문 또는 쿼리
 * @param apiKey - Gemini API 키 (필수)
 * @param metadataFilter - 메타데이터 필터 (선택사항)
 * @param model - 사용할 Gemini 모델 (기본값: gemini-2.5-flash)
 * @param systemInstruction - 시스템 지시사항 (선택사항)
 * @param generationConfig - 생성 구성 옵션 (선택사항)
 * @param safetySettings - 안전 설정 (선택사항)
 * @returns AI 생성 응답 객체
 */
export async function generateContentWithFileSearch(
  fileStore: FileSearchStore,
  query: string,
  apiKey: string,
  metadataFilter: string | null = null,
  model: string = "gemini-2.5-flash",
  systemInstruction?: string,
  generationConfig?: any,
  safetySettings?: any[]
): Promise<QueryResponse> {
  console.log(`\n💬 쿼리로 콘텐츠 생성 중: "${query}" (모델: ${model})`);

  const ai = getAI(apiKey);

  // API 호출 시 전체 이름 사용
  const fullStoreName = getFullStoreName(fileStore.name);

  const toolsConfig: any = {
    fileSearch: {
      fileSearchStoreNames: [fullStoreName],
    },
  };

  if (metadataFilter) {
    toolsConfig.fileSearch.metadataFilter = metadataFilter;
  }

  // config 객체 구성
  const config: any = {
    tools: [toolsConfig],
  };

  // systemInstruction 설정 (제공된 경우 사용, 아니면 기본값)
  if (systemInstruction) {
    config.systemInstruction = systemInstruction;
  } else {
    config.systemInstruction =
      "답변은 다음 형식으로 작성해주세요: 답변을 md형식으로 작성해주세요. 답변은 짧고 요점을 명확하게 작성해주세요. 순서대로 정리되게 작성해주세요.";
  }

  // generationConfig 추가 (제공된 경우)
  if (generationConfig) {
    config.generationConfig = generationConfig;
  }

  // safetySettings 추가 (제공된 경우)
  if (safetySettings && safetySettings.length > 0) {
    config.safetySettings = safetySettings;
  }

  // 재시도 로직 적용하여 쿼리 실행
  const response = await retryWithBackoff(async () => {
    return await ai.models.generateContent({
      model,
      contents: query,
      config,
    });
  });

  console.log(`\n📝 모델 응답:\n${response.text}\n`);

  // Grounding 메타데이터 확인
  if (response.candidates?.[0]?.groundingMetadata) {
    console.log(`📚 groundingMetadata에서 인용 정보를 확인할 수 있습니다`);
  }

  return {
    text: response.text || "",
    groundingMetadata: response.candidates?.[0]?.groundingMetadata as any,
    candidates: response.candidates as any,
  };
}

// ============================================
// Document Management Functions
// ============================================

/**
 * Store 내 특정 문서 찾기
 *
 * @param fileStore - 검색할 스토어 객체
 * @param displayName - 찾을 문서의 표시 이름
 * @param apiKey - Gemini API 키 (필수)
 * @returns 찾은 문서 정보
 * @throws 문서를 찾을 수 없을 경우
 */
export async function findDocumentByDisplayName(
  fileStore: FileSearchStore,
  displayName: string,
  apiKey: string
): Promise<FileSearchDocument> {
  console.log(`\n🔍 문서 검색 중: ${displayName}`);

  const ai = getAI(apiKey);

  // API 호출 시 전체 이름 사용
  const fullStoreName = getFullStoreName(fileStore.name);

  let targetDoc: FileSearchDocument | null = null;
  const documentPager = await ai.fileSearchStores.documents.list({
    parent: fullStoreName,
  });
  const page = documentPager.page;

  for (const document of page) {
    if (document.displayName === displayName && document.name) {
      targetDoc = {
        name: document.name,
        displayName: document.displayName,
        createTime: document.createTime || new Date().toISOString(),
        updateTime: document.updateTime || new Date().toISOString(),
        metadata: (document as any).metadata as
          | Record<string, string>
          | undefined,
        mimeType: document.mimeType,
        sizeBytes:
          typeof document.sizeBytes === "string"
            ? parseInt(document.sizeBytes)
            : document.sizeBytes,
      };
      break;
    }
  }

  if (!targetDoc) {
    throw new Error(`'${displayName}' 문서를 찾을 수 없습니다.`);
  }

  console.log(`✅ 문서를 찾았습니다: ${targetDoc.name}`);

  return targetDoc;
}

/**
 * Store 내 모든 문서 목록 조회
 *
 * @param fileStore - 스토어 객체
 * @param apiKey - Gemini API 키 (필수)
 * @returns 문서 목록
 */
export async function listDocuments(
  fileStore: FileSearchStore,
  apiKey: string
): Promise<FileSearchDocument[]> {
  console.log(`\n📋 문서 목록 조회 중: ${fileStore.displayName}`);

  const ai = getAI(apiKey);

  // API 호출 시 전체 이름 사용
  const fullStoreName = getFullStoreName(fileStore.name);

  const documents: FileSearchDocument[] = [];
  const documentPager = await ai.fileSearchStores.documents.list({
    parent: fullStoreName,
  });
  const page = documentPager.page;

  console.log(`\n📄 문서 수: ${page.length}`);

  for (const doc of page) {
    if (doc.name) {
      // displayName이 없으면 name의 마지막 부분을 사용
      const displayName =
        doc.displayName || doc.name.split("/").pop() || doc.name;

      console.log(`  📄 문서 추가:`, {
        name: doc.name,
        displayName,
        originalDisplayName: doc.displayName,
      });

      documents.push({
        name: doc.name,
        displayName,
        createTime: doc.createTime || new Date().toISOString(),
        updateTime: doc.updateTime || new Date().toISOString(),
        metadata: (doc as any).metadata as Record<string, string> | undefined,
        mimeType: doc.mimeType,
        sizeBytes:
          typeof doc.sizeBytes === "string"
            ? parseInt(doc.sizeBytes)
            : doc.sizeBytes,
      });
    }
  }

  console.log(`✅ ${documents.length}개의 문서를 찾았습니다`);

  return documents;
}

/**
 * 문서 삭제
 *
 * @param document - 삭제할 문서 객체
 * @param apiKey - Gemini API 키 (필수)
 */
export async function deleteDocument(
  document: FileSearchDocument,
  apiKey: string
): Promise<void> {
  console.log(`\n🗑️  문서 삭제 중: ${document.displayName}`);

  const ai = getAI(apiKey);
  await ai.fileSearchStores.documents.delete({
    name: document.name,
    config: { force: true },
  });

  console.log(`✅ 문서가 성공적으로 삭제되었습니다`);
}

/**
 * 문서 업데이트
 *
 * @param fileStore - 문서가 속한 스토어 객체
 * @param docDisplayName - 업데이트할 문서의 표시 이름
 * @param localDocPath - 새 버전 파일의 로컬 경로
 * @param apiKey - Gemini API 키 (필수)
 * @returns 업로드 완료된 operation 결과
 */
export async function updateDocument(
  fileStore: FileSearchStore,
  docDisplayName: string,
  localDocPath: string,
  apiKey: string
): Promise<Operation> {
  console.log(`\n🔄 문서 업데이트 중: ${docDisplayName}`);

  const ai = getAI(apiKey);

  // API 호출 시 전체 이름 사용
  const fullStoreName = getFullStoreName(fileStore.name);

  // 1. 기존 문서 찾기
  const documentPager = await ai.fileSearchStores.documents.list({
    parent: fullStoreName,
  });
  let foundDoc: any = null;

  for (const doc of documentPager.page) {
    if (doc.displayName === docDisplayName) {
      foundDoc = doc;
      break;
    }
  }

  // 2. 기존 문서가 있으면 삭제
  if (foundDoc) {
    await ai.fileSearchStores.documents.delete({
      name: foundDoc.name,
      config: { force: true },
    });
    console.log(`✅ 이전 버전이 삭제되었습니다`);
  }

  // 3. 새 버전 파일 업로드 및 인덱싱
  let updateOp = await ai.fileSearchStores.uploadToFileSearchStore({
    file: localDocPath,
    fileSearchStoreName: fullStoreName,
    config: { displayName: docDisplayName },
  });

  while (!updateOp.done) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    updateOp = await ai.operations.get({ operation: updateOp });
  }

  console.log(`✅ 새 버전이 업로드되고 인덱싱되었습니다`);

  return updateOp as Operation;
}
