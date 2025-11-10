export type AttrType =
  | "string" | "integer" | "boolean" | "datetime" | "reference" | "complex";

export interface AttributeInfo {
  name: string;
  type: AttrType;
  description?: string;

  required?: boolean;
  multiValued?: boolean;
  creatable?: boolean;
  updateable?: boolean;
  readable?: boolean;
  returnedByDefault?: boolean;

  subAttributes?: AttributeInfo[]; // for complex
}

export interface ObjectClassInfo {
  name: string;
  nativeName?: string;
  idAttribute?: string;
  nameAttribute?: string;
  supports?: Array<"CREATE"|"UPDATE"|"DELETE"|"GET"|"SEARCH"|"SYNC">;
  attributes: AttributeInfo[];
}

export interface Schema {
  objectClasses: ObjectClassInfo[];
  features?: {
    scriptOnConnector?: boolean;
    resolveUsername?: boolean;
    paging?: boolean;
    sorting?: boolean;
    complexAttributes?: boolean;
  };
}
