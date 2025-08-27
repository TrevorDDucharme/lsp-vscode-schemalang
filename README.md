# SchemaLang Syntax Guide

## Overview
SchemaLang is a schema definition language that allows you to define structured data types with detailed metadata including constraints, relationships, and documentation. It supports generating code for multiple targets including C++, JSON schemas, MySQL, and SQLite.

## CLI Usage

### Basic Command Structure
```bash
SchemaLangTranspiler -schemaDirectory=<path> -outputDirectory=<path> [flags]
```

### Required Parameters
- `-schemaDirectory=<path>` - Path to directory containing `.schema` or `.schemaLang` files
- `-schema=<file>` - Path to a single `.schema` or `.schemaLang` file (alternative to `-schemaDirectory`)
- `-outputDirectory=<path>` - Path where generated files will be created

### Generator Flags
- `-cpp` - Generate C++ classes with getters/setters
- `-java` - Generate Java classes (currently in development)
- `-lua` - Generate Lua modules and classes (currently in development)
- `-json` - Generate JSON schema files
- `-sqlite` - Generate SQLite database operations
- `-mysql` - Generate MySQL database operations

### Optional Flags
- `-help` - Display usage information
- `-R` - Recursively process subdirectories for schema files
- `-additionalGenerators=<path>` - Path to directory containing dynamic generator libraries (.dll/.so files)

### Advanced Options
**Warning: The following flags generate exponential numbers of files and should be used with caution**

- `-enableExponentialOperations` - Required flag to enable exponential file generation
- `-selectAllFiles` - Generate SELECT ALL operation files for all field combinations
- `-selectFiles` - Generate SELECT operation files for all field combinations  
- `-insertFiles` - Generate INSERT operation files for all field combinations
- `-updateFiles` - Generate UPDATE operation files for all field combinations
- `-deleteFiles` - Generate DELETE operation files for all field combinations

### Examples

**Basic C++ generation:**
```bash
SchemaLangTranspiler -schemaDirectory=./schemas -outputDirectory=./output -cpp
```

**Multi-target generation with drop-in system:**
```bash
SchemaLangTranspiler -schemaDirectory=./schemas -outputDirectory=./output -cpp -json -sqlite
```

**Recursive directory processing:**
```bash
SchemaLangTranspiler -schemaDirectory=./schemas -outputDirectory=./output -cpp -json -R
```

**Generate with exponential operations (use with caution):**
```bash
SchemaLangTranspiler -schemaDirectory=./schemas -outputDirectory=./output -mysql -enableExponentialOperations -selectFiles
```

**Using dynamic generators:**
```bash
SchemaLangTranspiler -schemaDirectory=./schemas -outputDirectory=./output -additionalGenerators=./generators -cpp -json
```

### Including other schemas

SchemaLang supports including other schema files from within a schema using an include directive. This lets you split definitions across files and reference types defined elsewhere. Example:

```
include "./other.schema"

struct LocalStruct {
    OtherStruct: required: description("References a struct defined in other.schema");
}
```

When a schema file includes another file, the included file's definitions are merged into the same ProgramStructure so you can use types, enums, and other definitions from the included file as if they were defined in the current file.


### Output Structure
Generated files are organized in subdirectories based on the target:
- `<outputDirectory>/Schemas/Cpp/` - C++ header and source files
- `<outputDirectory>/Schemas/Java/` - Java class files  
- `<outputDirectory>/Schemas/Lua/` - Lua module files
- `<outputDirectory>/Schemas/Json/` - JSON schema files
- `<outputDirectory>/Schemas/Sqlite/` - SQLite operation files
- `<outputDirectory>/Schemas/Mysql/` - MySQL operation files
- `<outputDirectory>/Schemas/[GeneratorName]/` - Dynamic generator output files (named by generator)

## Dynamic Generator System

SchemaLang supports loading additional generators dynamically from shared libraries (.dll on Windows, .so on Linux). This allows you to create custom generators that extend the functionality of the transpiler without modifying the core codebase.

### Using Dynamic Generators

To use dynamic generators, specify the directory containing your generator libraries:

```bash
./SchemaLangTranspiler -additionalGenerators=/path/to/generators -schemaDirectory=/path/to/schemas -outputDirectory=/path/to/output -cpp -json
```

### Creating Dynamic Generators

Dynamic generators are compiled as shared libraries that implement the `Generator` interface. They can also register their own command-line arguments for customization.

#### Basic Dynamic Generator Structure

1. **Create a generator class** that inherits from `Generator`
2. **Implement all pure virtual methods**
3. **Create factory and identification functions** using `extern "C"`
4. **Optionally register custom arguments** for your generator

#### Example Implementation

```cpp
// MyCustomGenerator.hpp
#pragma once
#include <Generator.hpp>

class MyCustomGenerator : public Generator
{
public:
    std::string convert_to_local_type(ProgramStructure *ps, TypeDefinition type) override;
    bool add_generator_specific_content_to_struct(Generator *gen, ProgramStructure *ps, StructDefinition &s) override;
    bool generate_files(ProgramStructure ps, std::string out_path) override;
};

// MyCustomGenerator.cpp
#include "MyCustomGenerator.hpp"
#include <DynamicGeneratorInterface.hpp>

static MyCustomGenerator* g_generator = nullptr;
static bool g_enableSpecialFeature = false;
static std::string g_outputFormat = "default";

// Implement Generator methods
std::string MyCustomGenerator::convert_to_local_type(ProgramStructure *ps, TypeDefinition type)
{
    // Convert SchemaLang types to your target language types
    if (type.name == "string") return "MyString";
    if (type.name == "int32") return "MyInt32";
    // ... more conversions
    return "Unknown";
}

bool MyCustomGenerator::add_generator_specific_content_to_struct(Generator *gen, ProgramStructure *ps, StructDefinition &s)
{
    // Add custom methods or content to generated structs
    // This is called during the drop-in system integration
    return true;
}

bool MyCustomGenerator::generate_files(ProgramStructure ps, std::string out_path)
{
    // Generate your custom output files
    // Use g_enableSpecialFeature and g_outputFormat for customization
    return true;
}

// Export functions for dynamic loading
extern "C" {
    Generator* getGeneratorInstance() {
        if (!g_generator) {
            g_generator = new MyCustomGenerator();
        }
        return g_generator;
    }
    
    const char* getGeneratorName() {
        return "MyCustomGenerator";  // This name will be used for the output directory
    }
    
    void registerArguments(argumentParser* parser) {
        // Register custom command-line arguments
        Flag* specialFeatureFlag = new Flag("enableSpecialFeature", false, []() {
            g_enableSpecialFeature = true;
            std::cout << "Special feature enabled for MyCustomGenerator" << std::endl;
        }, 1);
        
        Parameter* outputFormatParam = new Parameter("myOutputFormat", false, [](std::string value) {
            g_outputFormat = value;
            std::cout << "Output format set to: " << value << std::endl;
        }, 1);
        
        parser->addFlag(specialFeatureFlag);
        parser->addParameter(outputFormatParam);
    }
}
```

#### Building Dynamic Generators

Compile your generator as a shared library:

```bash
# Linux
g++ -shared -fPIC -o MyCustomGenerator.so MyCustomGenerator.cpp -I/path/to/schemalang/include

# Windows (MinGW)
g++ -shared -o MyCustomGenerator.dll MyCustomGenerator.cpp -I/path/to/schemalang/include

# Windows (MSVC)
cl /LD MyCustomGenerator.cpp /I"C:\path\to\schemalang\include" /Fe:MyCustomGenerator.dll
```

### Dynamic Generator Features

#### Argument Registration System

Dynamic generators can register their own command-line arguments that will be processed by the main argument parser. This allows users to customize generator behavior without modifying the core transpiler:

```bash
# Using custom arguments from dynamic generators
./SchemaLangTranspiler -additionalGenerators=./generators -schemaDirectory=./schemas -outputDirectory=./output -cpp -enableSpecialFeature -myOutputFormat=xml
```

#### Drop-In System Integration

Dynamic generators automatically integrate with the drop-in system:

- **Added to CppGenerator**: Dynamic generators are automatically registered with the C++ generator for method injection
- **Cross-Generator References**: Dynamic generators can reference and use other generators (both built-in and dynamic)
- **Unified Interface**: Generated classes can include methods from multiple generators seamlessly

#### Loading Process

The transpiler automatically:

1. **Scans the directory** for .dll/.so files
2. **Loads each library** using Boost.DLL
3. **Calls `getGeneratorInstance()`** to create generator instances
4. **Calls `getGeneratorName()`** to get the generator name for output directory naming
5. **Calls `registerArguments()`** (if available) to register custom arguments
6. **Integrates generators** into the drop-in system
7. **Processes arguments** including custom ones from dynamic generators
8. **Generates output files** using all enabled generators with named output directories

### Advanced Dynamic Generator Capabilities

#### Generator Interaction

Dynamic generators can interact with built-in generators and other dynamic generators:

```cpp
bool MyCustomGenerator::add_generator_specific_content_to_struct(Generator *gen, ProgramStructure *ps, StructDefinition &s)
{
    // Check if this is being called by the C++ generator
    if (/* gen is CppGenerator */) {
        // Add C++-specific methods to the struct
        // These will be injected into the generated C++ class
    }
    return true;
}
```

#### Custom Output Directories

Dynamic generators get their own named output directories based on the generator name:
- `<outputDirectory>/Schemas/[GeneratorName]/` - Named after the generator (e.g., "MyCustomGenerator")

The generator name is obtained from the required `getGeneratorName()` function and is used to create a clean, identifiable output directory structure.

#### Error Handling

The system provides comprehensive error handling:
- **Library Loading Errors**: Reported with specific error messages
- **Missing Functions**: Warnings for libraries without required functions
- **Argument Conflicts**: Automatic handling of argument name conflicts
- **Runtime Errors**: Graceful handling of generator runtime failures

### Use Cases for Dynamic Generators

- **Custom Language Support**: Generate code for languages not built into SchemaLang
- **Specialized Formats**: Create generators for specific file formats or protocols
- **Framework Integration**: Generate code specific to particular frameworks or libraries
- **Custom Validation**: Add specialized validation logic for specific domains
- **Protocol Buffers**: Generate .proto files or other schema formats
- **API Documentation**: Generate API documentation in custom formats
- **Test Code Generation**: Create unit tests or mock objects automatically

The dynamic generator system makes SchemaLang highly extensible while maintaining the benefits of the drop-in system and unified command-line interface.

## Basic Structure

### 1. **Struct Definition**
```
struct StructName {
    field_definition;
    field_definition;
    field_definition;
    more_field_definitions...
}

struct StructName: gen_modifier(Cpp,SQLite,...){
    field_definitions...
}
```

### 2. **Field Definition Syntax**
```
type: field_name: modifiers: description("text");
```

**Components:**
- **type**: The data type (primitive, array, enum, or custom struct)
- **field_name**: The name of the field (identifier)
- **modifiers**: Optional attributes that define constraints and behaviors
- **description**: Human-readable documentation (required)

## Data Types

### Primitive Types
- **Integer Types:**
  - `int8` - 8-bit signed integer
  - `int16` - 16-bit signed integer  
  - `int32` - 32-bit signed integer
  - `int64` - 64-bit signed integer
  - `uint8` - 8-bit unsigned integer
  - `uint16` - 16-bit unsigned integer
  - `uint32` - 32-bit unsigned integer
  - `uint64` - 64-bit unsigned integer

- **Floating Point Types:**
  - `float` - Single precision floating point
  - `double` - Double precision floating point

- **Special Types**
  - `pointer` - A reference to an item in another struct
  - `array` - An array of items structure depends on generator used may be Many->One, may be list of full objects, may be list of references

- **Other Types:**
  - `bool` - Boolean (true/false)
  - `string` - Text string
  - `char` - Single character
  - `uchar` - Unsigned character
  - `void` - Void type (mainly for function returns)

### Complex Types
- `array<Type>` - Array of specified type
- `enum` - Enumeration (defined separately)
- Custom struct types (reference other defined structs)

## Modifiers

### Core Modifiers
- `required` - Field must have a value (default: false)
- `optional` - Field can be null/empty (explicit declaration)
- `unique` - Value must be unique across all instances
- `primary_key` - Designates the primary key field
- `auto_increment` - Automatically increments for new records

### Relationship Modifiers
- `reference(StructName.field)` - Creates a foreign key relationship

### Array Modifiers
- `unique_items` - Array elements must be unique
- `min_items(n)` - Minimum number of items required (n = positive integer)
- `max_items(n)` - Maximum number of items allowed (n = positive integer)

### AI Generation Modifiers via jsonSchema
- `description("text")` - Documentation string explaining the field's purpose (required for all fields)

### Generator Modifiers
- `gens_enabled(GENERATOR,GENERATOR,...)` - Enables a whitelist for which generators will include this item in their generated code 
- `gens_disabled(GENERATOR,GENERATOR,...)` - Enables a blacklist for which generators will exclude this item in their generated code

## Enum Definition

### Basic Enum
```
enum EnumName {
    Value1,
    Value2,
    Value3
}
```

### Enum with Explicit Values
```
enum Status {
    Inactive = 0,
    Active = 1,
    Suspended = 2
}
```

**Enum Rules:**
- Enum values are comma-separated
- Last value can optionally omit the trailing comma
- Values can be explicitly assigned integers using `=`
- If no value is specified, it auto-increments from the previous value (starting at 0)

### Lexical Rules
- **Identifiers**: Start with letter or underscore, followed by letters, numbers, or underscores
- **Strings**: Enclosed in double quotes, support escape sequences with backslash
- **Integers**: Sequence of digits (0-9)
- **Comments**: Supports // and /*...*/
- **Whitespace**: Spaces, tabs, and newlines are ignored except within strings

## Examples

### Simple Struct
```
struct Organization {
    int64: id: primary_key: required: unique: auto_increment: description("The unique identifier of the organization");
    string: name: required: description("The name of the organization");
    string: description: required: description("The description of the organization");
}
```

### Struct with Array Field
```
struct SCP {
    int64: id: primary_key: required: unique: auto_increment: description("The unique identifier of the SCP");
    string: name: required: description("The common name of the SCP");
    Classification: objectClass: required: description("The object class of the SCP");
    array<Addendum>: addenda: optional: description("The addenda of the SCP"): unique_items: min_items(4);
}
```

### Struct with Foreign Key
```
struct DClass {
    int64: id: primary_key: required: unique: auto_increment: description("The unique identifier of the D-Class"): reference(Personel.id);
    string: designation: required: description("The designation of the D-Class");
    string: reason: required: description("The reason for the D-Class being in foundation possession");
}
```

### Equivalent representations

The two snippets below are equivalent: they both model a one-to-many or many-to-one relationship where a Character can have multiple aliases. The first form represents aliases as a separate struct with a foreign key to `Character.id`. The second form places an array of alias objects directly on `Character`. Depending on the target generator, these can produce the same underlying schema (for example, a separate SQL table for aliases with a foreign key to the character, or an embedded array in a JSON schema). 

Equivalent (separate alias struct with foreign key):

```
struct CharacterAlias {
    string: alias: required: description("An alternative name or nickname for a character");
    int64: character_id: required: reference(Character.id): description("The ID of the character this alias belongs to");
}

struct Character {
    string: name: required: description("The name for a character");
}
```

Equivalent (array field on Character):

```
struct CharacterAlias {
    string: alias: required: description("An alternative name or nickname for a character");
}

struct Character {
    string: name: required: description("The name for a character");
    array<CharacterAlias>: aliases: required: description("Aliases for the character");
}
```

How these map in generators:
- SQL generators (MySQL/SQLite) will usually create a separate `CharacterAlias` table and add a foreign key `character_id` referencing `Character.id` (matching the first form). When the schema uses an `array<...>` of a complex type, generators commonly flatten that into a separate table with a foreign key as well.
- JSON-schema generators will typically represent the second form as an array of objects inside the `Character` schema, while the first form will be two separate definitions with a relationship documented via references.

Both forms express the same logical relationship (one Character -> many Aliases); choose the style that best fits your readability or generator behavior.


### Enum with Mixed Value Assignment
```
enum Classification {
    None,
    Safe,
    Euclid,
    Keter,
    Thaumiel,
    Neutralized,
    Pending,
    Explained,
    Esoteric,
}
```

### Complex Struct with Multiple Field Types
```
struct Personel {
    int64: id: primary_key: required: unique: auto_increment: description("The unique identifier of the personel");
    Title: title: required: description("The title of the personel");
    string: first_name: required: description("The first name of the personel");
    string: second_name: optional: description("The middle name of the personel");
    string: last_name: required: description("The last name of the personel");
    Sex: sex: optional: description("the sex of the personel");
    string: email: required: description("The email of the personel");
    string: phone: required: description("The phone number of the personel");
    Organization: organization: required: description("The organization the personel is a part of");
}
```

## Best Practices

1. **Always include descriptions** - Every field must have a description explaining its purpose
2. **Use meaningful names** - Choose clear, descriptive names for structs, fields, and enums
3. **Specify constraints explicitly** - Always declare `required` or `optional` for clarity
4. **Use appropriate data types** - Choose the right size integers, use `int64` for IDs
5. **Define relationships** - Use references when linking between structs
6. **Use enums for constrained values** - Define enums for fields with a fixed set of possible values
7. **Include validation constraints** - Use `min_items`, `max_items`, `unique_items` where appropriate
8. **Organize definitions** - Define enums before structs that use them
9. **Follow naming conventions** - Use consistent naming patterns across your schema

## Syntax Rules and Constraints

- **Field Termination**: All field definitions must end with a semicolon (`;`)
- **Modifier Separation**: Multiple modifiers are separated by colons (`:`)
- **Array Syntax**: Array types use angle brackets: `array<Type>`
- **Enum Values**: Comma-separated, with optional trailing comma
- **String Literals**: Must be enclosed in double quotes, support escape sequences
- **Foreign Key Format**: Must reference existing struct and field: `StructName.field`
- **Case Sensitivity**: All identifiers are case-sensitive
- **Reserved Words**: Cannot use data type names as identifiers

## Error Handling

The parser provides detailed error messages for common syntax errors:
- Missing colons or semicolons
- Invalid type names
- Malformed array syntax
- Invalid foreign key references
- Missing or malformed descriptions
- Invalid modifier parameters

## Code Generation

SchemaLang can generate code for multiple targets, each with specific capabilities:

### Object-Oriented Language Generators

- **C++**: Complete classes with private member variables, getters/setters, constructors, and support for generator drop-ins
- **Java**: Complete classes with private member variables, getters/setters, constructors, and support for generator drop-ins (currently in development)
- **Lua**: Complete modules with constructor functions, methods, and support for generator drop-ins (currently in development)

### Schema and Database Generators

- **JSON Schema**: Complete JSON schema definitions with validation rules and type constraints
- **MySQL**: Database schema with CREATE TABLE statements, indexes, and foreign key constraints
- **SQLite**: Database schema with CREATE TABLE statements, indexes, and foreign key constraints

### Generator Capabilities

#### Standalone Generation

Each generator can work independently:

- **C++/Java/Lua**: Produces clean, well-structured classes/modules suitable for any application
- **JSON Schema**: Creates comprehensive schemas for API validation and documentation
- **MySQL/SQLite**: Generates complete database schemas ready for deployment

#### Drop-In Enhanced Generation

When combined with C++, Java, or Lua generators, specialized generators can enhance the generated classes:

**JSON + C++/Java/Lua:**

- Creates base classes for serialization (`HasJsonSchema`)
- Injects `toJSON()`, `fromJSON()`, and `getSchema()` methods
- Provides complete JSON serialization/deserialization implementations

**SQLite + C++/Java/Lua:**

- Directly injects database operation methods
- Adds SELECT methods for each field (e.g., `SQLiteSelectByid()`, `SQLiteSelectBytitle()`)
- Includes INSERT, UPDATE, and table creation methods
- Provides both static utility methods and instance methods

**MySQL + C++/Java/Lua:**

- Directly injects MySQL X DevAPI methods (C++/Java) or Lua methods (Lua)
- Adds SELECT methods returning vectors of objects (C++/Java) or tables (Lua)
- Includes INSERT, UPDATE, and table creation methods
- Supports both static operations and instance methods

#### Multi-Generator Combinations

SchemaLang excels when multiple generators are used together:

- **C++ + JSON + SQLite**: Creates classes with JSON serialization and SQLite database operations
- **C++ + MySQL + JSON**: Combines MySQL database operations with JSON API capabilities
- **C++ + SQLite + MySQL + JSON**: Full-stack classes with multiple database backends and serialization
- **Lua + JSON + SQLite**: Creates Lua modules with JSON serialization and SQLite operations using lua-cjson and luasql-sqlite3
- **Java + JSON + MySQL**: Creates Java classes with Jackson JSON support and JDBC database operations

Each generator respects the modifiers and constraints defined in the schema, ensuring consistency across all generated outputs. The drop-in system allows for seamless integration between generators, creating powerful, unified classes that handle data persistence, serialization, and validation automatically.

## Generator Drop-In System

SchemaLang features an advanced **generator drop-in system** that allows specialized generators (SQLite, MySQL, JSON) to inject methods and base classes into object-oriented language generators (C++, Java, Lua). This creates a unified interface where database operations, serialization, and schema validation are seamlessly integrated into the generated classes.

**Current Status:**
- **C++**: Fully implemented and stable
- **Java**: In development - basic functionality implemented, drop-in system active
- **Lua**: In development - basic functionality implemented, drop-in system with common Lua libraries (lua-cjson, luasql-sqlite3, luasql-mysql)

### How the Drop-In System Works

When multiple generators are enabled (e.g., `--cpp --sqlite --json`), the system works as follows:

1. **Base Class Generation** (Optional): Some generators can instruct the C++/Java generator to create base classes with virtual methods
2. **Method Injection**: Database and serialization generators inject specific method definitions into the generated classes
3. **Implementation Drop-In**: Generators provide complete implementations for their injected methods
4. **Inheritance Setup** (When Base Classes Used): Generated classes inherit from appropriate base classes and implement virtual methods

**Note**: Base classes are optional - generators can choose to either create base classes with virtual methods (like JSON) or simply inject methods directly into classes (like SQLite and MySQL).

### Example: JSON Generator Integration

When the JSON generator is enabled with C++, it creates a base class `HasJsonSchema` and injects these methods:

```cpp
// Base class provided by JSON generator
class HasJsonSchema {
public:
    virtual json toJSON() = 0;
    virtual void fromJSON(json j) = 0;
    virtual json getSchema() = 0;
};

// Methods injected into generated classes
json toJSON() override;
void fromJSON(json j) override;
json getSchema() override;
```

### Example: SQLite Generator Integration

When the SQLite generator is enabled with C++, it directly injects database operation methods without creating a base class:

```cpp
// Select methods (by each field) - injected directly
void SQLiteSelectByid(sqlite3 * db, int64_t id);
void SQLiteSelectBytitle(sqlite3 * db, std::string title);
void SQLiteSelectBycontent(sqlite3 * db, std::string content);

// Insert methods - injected directly
static bool SQLiteInsert(sqlite3 * db, int64_t id, std::string title, std::string content);
bool SQLiteInsert(sqlite3 * db);

// Schema and table creation - injected directly
static std::string getSQLiteCreateTableStatement();
static bool SQLiteCreateTable(sqlite3 * db);
```

### Example: MySQL Generator Integration

Similarly, the MySQL generator directly injects MySQL-specific methods without a base class:

```cpp
// Select methods using MySQL X DevAPI - injected directly
static std::vector<AddendumSchema*> MySQLSelectByid(mysqlx::Session & session, int64_t id);
static std::vector<AddendumSchema*> MySQLSelectBytitle(mysqlx::Session & session, std::string title);
static std::vector<AddendumSchema*> MySQLSelectBycontent(mysqlx::Session & session, std::string content);

// Insert and update methods - injected directly
static bool MySQLInsert(mysqlx::Session & session, int64_t id, std::string title, std::string content);
bool MySQLInsert(mysqlx::Session & session);
static bool MySQLUpdateAddendum(mysqlx::Session & session, int64_t id, std::string title, std::string content);

// Schema and table creation - injected directly
static std::string getMySQLCreateTableStatement();
static bool MySQLCreateTable(mysqlx::Session & session);
```

### Complete Example: Addendum Class

When all generators are enabled, a struct like this:

```schemalang
struct Addendum {
    int64: id: required: unique: auto_increment: reference(SCP.id): description("The SCP this addendum is attached to");
    string: title: required: description("The title of the addendum");
    string: content: required: description("The content of the addendum");
}
```

Generates a C++ class with all these capabilities:

```cpp
class AddendumSchema : public HasJsonSchema {  // Inherits from JSON base class
private:
    int64_t id;
    std::string title;
    std::string content;

public:
    // Standard getters and setters
    int64_t getId() const { return id; }
    void setId(int64_t value) { id = value; }
    std::string getTitle() const { return title; }
    void setTitle(const std::string& value) { title = value; }
    std::string getContent() const { return content; }
    void setContent(const std::string& value) { content = value; }

    // JSON serialization methods (from JSON generator - overridden from base class)
    json toJSON() override;
    void fromJSON(json j) override;
    json getSchema() override;

    // SQLite database methods (from SQLite generator - directly injected)
    void SQLiteSelectByid(sqlite3 * db, int64_t id);
    void SQLiteSelectBytitle(sqlite3 * db, std::string title);
    void SQLiteSelectBycontent(sqlite3 * db, std::string content);
    static bool SQLiteInsert(sqlite3 * db, int64_t id, std::string title, std::string content);
    bool SQLiteInsert(sqlite3 * db);
    static std::string getSQLiteCreateTableStatement();
    static bool SQLiteCreateTable(sqlite3 * db);

    // MySQL database methods (from MySQL generator - directly injected)
    static std::vector<AddendumSchema*> MySQLSelectByid(mysqlx::Session & session, int64_t id);
    static std::vector<AddendumSchema*> MySQLSelectBytitle(mysqlx::Session & session, std::string title);
    static std::vector<AddendumSchema*> MySQLSelectBycontent(mysqlx::Session & session, std::string content);
    static bool MySQLInsert(mysqlx::Session & session, int64_t id, std::string title, std::string content);
    bool MySQLInsert(mysqlx::Session & session);
    static bool MySQLUpdateAddendum(mysqlx::Session & session, int64_t id, std::string title, std::string content);
    static std::string getMySQLCreateTableStatement();
    static bool MySQLCreateTable(mysqlx::Session & session);
};
```

### Benefits of the Drop-In System

1. **Unified Interface**: Single class provides database operations, serialization, and validation
2. **Type Safety**: All operations use the correct types as defined in the schema
3. **Consistency**: Method naming and behavior is consistent across all generated classes
4. **Extensibility**: New generators can easily integrate with existing object-oriented generators
5. **Maintainability**: Changes to schema automatically update all related operations
6. **Performance**: Static methods avoid unnecessary object instantiation for utility operations

### Supported Generator Combinations

- **C++ & JSON**: Adds JSON serialization capabilities
- **C++ & SQLite**: Adds SQLite database operations
- **C++ & MySQL**: Adds MySQL database operations
- **C++ & Multiple**: Combines all selected generators into a single comprehensive class
- **Java & [Any]**: Same drop-in system (currently in development)
- **Lua & [Any]**: Same drop-in system with Lua-specific libraries (currently in development)

This drop-in system makes SchemaLang particularly powerful for full-stack development, allowing you to define your data model once and get complete database integration, API serialization, and type-safe operations across your entire application.

This comprehensive syntax enables you to define complex data structures with built-in validation, relationships, and documentation, making it ideal for generating database schemas, API specifications, or data validation code across multiple platforms and languages. The advanced generator drop-in system further enhances productivity by creating unified classes that combine database operations, serialization, and validation in a single, type-safe interface.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

The MIT License allows you to:
- Use SchemaLang commercially in your projects
- Modify and distribute the source code
- Use the generated code in proprietary applications without licensing restrictions
- Create and distribute your own dynamic generators

The only requirement is to include the copyright notice and license text in copies of the software.
