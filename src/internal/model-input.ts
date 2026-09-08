type FunctionMember = (...args: never[]) => unknown;

/**
 * Converts a generated Alibaba SDK model class into the plain object accepted
 * by its constructor. Method members inherited from the Darabonba base model
 * are deliberately removed, including from nested request models.
 */
export type ModelInput<T> = T extends FunctionMember
  ? never
  : T extends Date
    ? Date
    : T extends readonly (infer Item)[]
      ? ModelInput<Item>[]
      : T extends object
        ? {
            [Key in keyof T as T[Key] extends FunctionMember
              ? never
              : Key]: ModelInput<T[Key]>;
          }
        : T;

export type Without<T, Keys extends PropertyKey> = Omit<ModelInput<T>, Keys>;
