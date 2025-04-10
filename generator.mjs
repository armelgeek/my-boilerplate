
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import readline from 'readline';
import chalk from 'chalk';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);

// Create a readline interface for command line interaction
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (question) => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
};

// Helper function to format names in different cases
const formatName = (name, format) => {
  switch (format) {
    case 'pascal':
      return name.charAt(0).toUpperCase() + name.slice(1);
    case 'camel':
      return name.charAt(0).toLowerCase() + name.slice(1);
    case 'kebab':
      return name
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/\s+/g, '-')
        .toLowerCase();
    case 'snake':
      return name
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/\s+/g, '_')
        .toLowerCase();
    case 'plural':
      // Very simple pluralization - in a real app you might want to use a library like pluralize
      if (name.endsWith('y')) {
        return name.slice(0, -1) + 'ies';
      } else if (name.endsWith('s')) {
        return name;
      } else {
        return name + 's';
      }
    default:
      return name;
  }
};

// Function to ensure directory exists
const ensureDirectoryExists = async (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
};

// Parse Drizzle schema to get table fields
const parseSchema = async (schemaPath) => {
  try {
    const schemaContent = await readFile(schemaPath, 'utf8');

    // Extract the table definition
    const tableMatch = schemaContent.match(/export\s+const\s+(\w+)\s*=\s*\w+Table\s*\(\s*['"](\w+)['"]\s*,\s*{([^}]*)}\s*\)/s);

    if (!tableMatch) {
      throw new Error(`Could not find table definition in ${schemaPath}`);
    }

    const tableName = tableMatch[1];
    const dbTableName = tableMatch[2];
    const fieldsBlock = tableMatch[3];

    // Extract fields
    const fields = [];
    const fieldsRegex = /(\w+):\s*(\w+)\(['"](\w+)['"](,\s*{([^}]*)})?/g;
    let match;

    while ((match = fieldsRegex.exec(fieldsBlock)) !== null) {
      const fieldName = match[1];
      const fieldType = match[2];
      const dbFieldName = match[3];
      const options = match[5] || '';

      // Check if field is primary key or has other constraints
      const isPrimaryKey = options.includes('primaryKey');
      const isNotNull = options.includes('notNull');
      const isUnique = options.includes('unique');

      fields.push({
        name: fieldName,
        type: fieldType,
        dbName: dbFieldName,
        isPrimaryKey,
        isNotNull,
        isUnique,
      });
    }

    return {
      tableName,
      dbTableName,
      fields,
    };
  } catch (error) {
    console.error(chalk.red(`Error parsing schema: ${error.message}`));
    throw error;
  }
};

// Generate Types
const generateTypes = async (name, schema, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const typesContent = `import { z } from 'zod';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { ${schema.tableName} } from '@/drizzle/schema/${formatName(name, 'kebab')}';

export const ${pascalName}SelectSchema = createSelectSchema(${schema.tableName});

export const ${pascalName}FormSchema = createInsertSchema(${schema.tableName}, {
${schema.fields
      .filter(field => !field.isPrimaryKey && field.name !== 'createdAt' && field.name !== 'updatedAt')
      .map(field => {
        if (field.type === 'varchar' || field.type === 'text') {
          return `  ${field.name}: (s) => s.min(1, '${formatName(field.name, 'pascal')} is required.')${field.type === 'varchar' ? '.max(255, \'' + formatName(field.name, 'pascal') + ' must be at most 255 characters.\')' : ''
            },`;
        }
        return `  ${field.name}: (s) => s,`;
      })
      .join('\n')}
}).pick({
${schema.fields
      .filter(field => !field.isPrimaryKey && field.name !== 'createdAt' && field.name !== 'updatedAt')
      .map(field => `  ${field.name}: true,`)
      .join('\n')}
});

export type ${pascalName} = z.infer<typeof ${pascalName}SelectSchema>;

export type ${pascalName}Payload = z.infer<typeof ${pascalName}FormSchema>;

export type PaginatedPage = PaginatedResponse<${pascalName}>;`;

  await writeFile(path.join(outputDir, 'config', `${formatName(name, 'kebab')}.type.ts`), typesContent);
};

// Generate Schema
const generateSchema = async (name, schema, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const schemaContent = `import { z } from 'zod';

import { ${pascalName}FormSchema, ${pascalName}SelectSchema } from './${formatName(name, 'kebab')}.type';

export { ${pascalName}FormSchema, ${pascalName}SelectSchema };
`;

  await writeFile(path.join(outputDir, 'config', `${formatName(name, 'kebab')}.schema.ts`), schemaContent);
};

// Generate Query Keys
const generateKeys = async (name, outputDir) => {
  const keysContent = `import { createQueryKeys } from '@/shared/lib/utils/query-keys';

export const ${formatName(name, 'camel')}Keys = createQueryKeys({
  entity: '${formatName(name, 'camel')}',
  subEntity: '${formatName(name, 'camel')}'
});`;

  await writeFile(path.join(outputDir, 'config', `${formatName(name, 'kebab')}.key.ts`), keysContent);
};

// Generate Use Cases
const generateUseCases = async (name, schema, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');
  const pluralName = formatName(name, 'plural');

  const indexContent = `import { Filter } from "@/shared/lib/types/filter";
import { ${pascalName}Payload } from "../../config/${formatName(name, 'kebab')}.type";
import { ${camelName}UseCase } from "./${formatName(name, 'kebab')}.use-case";

export async function create${pascalName}(payload: ${pascalName}Payload) {
    return ${camelName}UseCase.create(payload);
}

export async function get${pascalName}(slug: string) {
    return ${camelName}UseCase.getById(slug);
}

export async function update${pascalName}(slug: string, payload: ${pascalName}Payload) {
    return ${camelName}UseCase.update(slug, payload);
}

export async function delete${pascalName}(slug: string) {
    return ${camelName}UseCase.delete(slug);
}

export async function get${formatName(pluralName, 'pascal')}(filter: Filter) {
    return ${camelName}UseCase.list(filter);
}`;

  await writeFile(path.join(outputDir, 'domain/use-cases', 'index.ts'), indexContent);

  const useCaseContent = `import 'server-only';
import { eq, sql } from 'drizzle-orm';
import slugify from 'slugify';
import { db } from '@/drizzle/db';
import { ${schema.tableName} } from '@/drizzle/schema/${formatName(name, 'kebab')}';
import { Filter } from '@/shared/lib/types/filter';
import { calculatePagination } from '@/shared/lib/utils/calculate-pagination';
import { createPagination } from '@/shared/lib/utils/create-pagination';
import { filterOrderByClause } from '@/shared/lib/utils/filter-order-by-clause';
import { filterWhereClause } from '@/shared/lib/utils/filter-where-clause';
import { UseCase } from '@/shared/lib/use-cases';
import { ${pascalName}, ${pascalName}Payload } from '../../config/${formatName(name, 'kebab')}.type';
import { ${pascalName}FormSchema } from '../../config/${formatName(name, 'kebab')}.schema';

export const ${camelName}UseCase = new UseCase<${pascalName}, ${pascalName}Payload, unknown>({
  name: '${pascalName}',
  schema: ${pascalName}FormSchema,
  operations: {
    async create(data: ${pascalName}Payload) {
      const slug = slugify(data.name, { lower: true });
      const existing${pascalName} = await db.query.${schema.tableName}.findFirst({
        where: eq(${schema.tableName}.slug, slug),
      });
      
      if (existing${pascalName}) {
        throw new Error('${pascalName} with this name already exists');
      }
      const [${camelName}] = await db
        .insert(${schema.tableName})
        .values({ ...data, slug })
        .returning();
        
      return ${camelName};
    },
    
    async getById(slug: string) {
      const ${camelName} = await db.query.${schema.tableName}.findFirst({
        where: eq(${schema.tableName}.slug, slug)
      });
      return ${camelName} ?? null;
    },
    
    async update(slug: string, data: ${pascalName}Payload) {
      await db
        .update(${schema.tableName})
        .set({ ...data, updatedAt: sql\`NOW()\` })
        .where(eq(${schema.tableName}.slug, slug));
      
      return { message: '${pascalName} updated successfully' };
    },
    
    async delete(slug: string) {
      await db
        .delete(${schema.tableName})
        .where(eq(${schema.tableName}.slug, slug));
      
      return { message: '${pascalName} deleted successfully' };
    },
    
    async list(filter: Filter) {
      const searchColumns = ['name'];
      const sortColumns = ['name'];

      const whereClause = {
        search: filter.search
      };
      const conditions = filterWhereClause(searchColumns, whereClause);
      const sort = filterOrderByClause(sortColumns, filter.sortBy, filter.sortDir);

      const [{ count }] = await db
        .select({
          count: sql<number>\`count(*)\`,
        })
        .from(${schema.tableName})
        .where(conditions);

      const { currentPage, itemsPerPage, offset } = calculatePagination(filter.page, filter.pageSize);
      const pagination = createPagination(count, currentPage, itemsPerPage, offset);

      const data = await db
        .select({
          id: ${schema.tableName}.id,
          name: ${schema.tableName}.name,
          slug: ${schema.tableName}.slug,
          createdAt: ${schema.tableName}.createdAt,
          updatedAt: ${schema.tableName}.updatedAt,
        })
        .from(${schema.tableName})
        .where(conditions)
        .orderBy(sort)
        .limit(itemsPerPage)
        .offset(offset);

      return {
        data,
        meta: {
          pagination,
        },
      };
    }
  }
});
`;

  await writeFile(path.join(outputDir, 'domain/use-cases', `${formatName(name, 'kebab')}.use-case.ts`), useCaseContent);
};

// Generate Service
const generateService = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const serviceContent = `import { createSearchParams } from '@/shared/domain/base.search-param';
import { BaseServiceImpl } from '@/shared/domain/base.service';
import { API_ENDPOINTS } from '@/shared/lib/config/api';
import type { Filter } from '@/shared/lib/types/filter';
import { ${pascalName}, ${pascalName}Payload } from '../config/${formatName(name, 'kebab')}.type';

const ${camelName}Search = createSearchParams();
export class ${pascalName}ServiceImpl extends BaseServiceImpl<${pascalName}, ${pascalName}Payload> {
  protected endpoints = API_ENDPOINTS.${formatName(formatName(name, 'plural'), 'camel')};
  protected serializeParams(filter: Filter): string {
    return ${camelName}Search.serialize(filter);
  }
}
export const ${camelName}Service = new ${pascalName}ServiceImpl();`;

  await writeFile(path.join(outputDir, 'domain', `${formatName(name, 'kebab')}.service.ts`), serviceContent);
};

// Generate Hooks
const generateHooks = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');
  const upperName = formatName(name, 'snake').toUpperCase();
  const pluralName = formatName(name, 'plural');
  const pluralPascal = formatName(pluralName, 'pascal');

  const hooksContent = `import { ${camelName}Service } from '../domain/${formatName(name, 'kebab')}.service';
import { ${pascalName}, ${pascalName}Payload } from '../config/${formatName(name, 'kebab')}.type';
import { Filter } from '@/shared/lib/types/filter';
import { useDetail, useList, useMutations } from '@/shared/lib/react-query/query-hooks';

export const ${upperName}_KEYS = {
  all: ['${formatName(pluralName, 'camel')}'] as const,
  lists: () => [...${upperName}_KEYS.all, 'list'] as const,
  list: (filters: Filter) => [...${upperName}_KEYS.lists(), { filters }] as const,
  details: () => [...${upperName}_KEYS.all, 'detail'] as const,
  detail: (slug: string) => [...${upperName}_KEYS.details(), slug] as const,
};

export const use${pluralPascal} = (filters: Filter) => {
  return useList<${pascalName}>(
    ${upperName}_KEYS,
    ${camelName}Service,
    filters
  );
};

export const use${pascalName} = (slug: string) => {
  const { data, isLoading } = useDetail<${pascalName}>(
    ${upperName}_KEYS,
    ${camelName}Service,
    slug
  );

  return {
    ${camelName}: data,
    isLoading,
  };
};

export const use${pascalName}Mutations = () => {

  const mutations = useMutations<${pascalName}, ${pascalName}Payload>({
    service: ${camelName}Service,
    queryKeys: ${upperName}_KEYS,
    successMessages: {
      create: '${pascalName} created successfully',
      update: '${pascalName} updated successfully',
      delete: '${pascalName} deleted successfully'
    },
    callbacks: {
      onCreateSuccess: () => {
     
      }
    }
  });

  return {
    create${pascalName}: mutations.create,
    update${pascalName}: mutations.update,
    delete${pascalName}: mutations.remove,
    isCreating: mutations.isCreating,
    isUpdating: mutations.isUpdating,
    isDeleting: mutations.isDeleting,
  };
};
`;

  await writeFile(path.join(outputDir, 'hooks', `use-${formatName(name, 'kebab')}.ts`), hooksContent);
};

// Generate Form Component
const generateFormComponent = async (name, schema, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const formContent = `import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { ControlledTextInput } from '@/shared/components/molecules/form/ControlledTextInput';
import { useFormHandler } from '@/shared/hooks/use-form-handler';

import { ${pascalName}, ${pascalName}Payload } from '../../config/${formatName(name, 'kebab')}.type';
import { ${pascalName}FormSchema } from '../../config/${formatName(name, 'kebab')}.schema';

interface ${pascalName}FormProps {
  initialData: Pick<${pascalName}, 'name'> | null;
  onSubmit: (input: ${pascalName}Payload) => Promise<void>;
  onSuccess?: () => void;
}

export const ${pascalName}Form = ({ initialData = null, onSubmit, onSuccess }: ${pascalName}FormProps) => {
  const { form, handleSubmit, isSubmitting } = useFormHandler<${pascalName}Payload>({
    schema: ${pascalName}FormSchema,
    initialValues: initialData || {
      name: ''
    },
    onSubmit,
    onSuccess
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-4">
          <ControlledTextInput
            name="name"
            label="Name"
            placeholder="${pascalName} Name"
            control={form.control}
          />

          <Button type="submit" className="mt-2" disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : initialData ? (
              'Edit ${pascalName}'
            ) : (
              'Add ${pascalName}'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}`;

  await writeFile(path.join(outputDir, 'components/molecules', `${formatName(name, 'kebab')}-form.tsx`), formContent);
};

// Generate Row Actions
const generateRowActions = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const rowActionsContent = `'use client';

import { useState } from 'react';

import { Row } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { Delete } from './delete';
import { Edit } from './edit';
import { ${pascalName} } from '../../config/${formatName(name, 'kebab')}.type';

interface DataTableRowActionsProps<TData> {
  row: Row<TData>;
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const [isOpen, setIsOpen] = useState(false);
  const ${camelName} = row.original as ${pascalName};

  return (
    <DropdownMenu
      open={isOpen}
      onOpenChange={(open) => setIsOpen(open)}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex h-8 w-8 p-0 data-[state=open]:bg-muted"
        >
          <MoreHorizontal
            size={16}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[160px]"
      >
        <Edit
          slug={${camelName}.slug}
        
        />
        <Delete
          slug={${camelName}.slug}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
`;

  await writeFile(path.join(outputDir, 'components/organisms', 'data-table-row-actions.tsx'), rowActionsContent);
};

// Generate Columns
const generateColumns = async (name, schema, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const columnsContent = `'use client';
  
  import { ColumnDef } from '@tanstack/react-table';
  
  import type { ${pascalName} } from '@/features/${formatName(name, 'kebab')}/config/${formatName(name, 'kebab')}.type';
  
  import { DataTableRowActions } from './data-table-row-actions';
  import { DataTableColumnHeader } from '@/shared/components/molecules/datatable/data-table-column-header';
  
  export const columns: ColumnDef<${pascalName}>[] = [
    {
      id: 'name',
      meta: 'Name',
      accessorKey: 'name',
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title="Name"
        />
      ),
      cell: ({ row }) => {
        return <div className="flex w-full">{row.getValue('name')}</div>;
      },
    },
    {
      id: 'actions',
      maxSize: 75,
      cell: ({ row }) => <DataTableRowActions row={row} />,
    },
  ];
  `;

  await writeFile(path.join(outputDir, 'components/organisms', 'columns.tsx'), columnsContent);
};

// Generate Add Component
const generateAddComponent = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const addContent = `import { ${pascalName}Form } from '../molecules/${formatName(name, 'kebab')}-form';
  import { use${pascalName}Mutations } from '../../hooks/use-${formatName(name, 'kebab')}';
  import { ${camelName}Keys } from '../../config/${formatName(name, 'kebab')}.key';
  import { ${pascalName}Payload } from '../../config/${formatName(name, 'kebab')}.type';
  import { EntityForm } from '@/shared/components/molecules/form/add-entity';
  
  export function Add() {
    const { create${pascalName}, isCreating } = use${pascalName}Mutations();
  
    const handleSubmit = async (data: ${pascalName}Payload) => {
      await create${pascalName}(data);
    };
  
    return (
      <EntityForm<${pascalName}Payload>
        title="${pascalName}"
        initialData={null}
        onSubmit={handleSubmit}
        isSubmitting={isCreating}
        Form={${pascalName}Form}
        queryKey={${camelName}Keys.all}
        mode="add"
      />
    );
  }`;

  await writeFile(path.join(outputDir, 'components/organisms', 'add.tsx'), addContent);
};

// Generate Edit Component
const generateEditComponent = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const editContent = `'use client';
  
  import { EntityForm } from '@/shared/components/molecules/form/add-entity';
  import { ${pascalName}Payload } from '../../config/${formatName(name, 'kebab')}.type';
  import { ${pascalName}Form } from '../molecules/${formatName(name, 'kebab')}-form';
  import { ${camelName}Keys } from '../../config/${formatName(name, 'kebab')}.key';
  import { use${pascalName}, use${pascalName}Mutations } from '../../hooks/use-${formatName(name, 'kebab')}';
  
  interface EditProps {
    slug: string;
    onComplete?: () => void;
  }
  
  export function Edit({ slug, onComplete }: EditProps) {
    const { ${camelName} } = use${pascalName}(slug);
    const { update${pascalName}, isUpdating } = use${pascalName}Mutations();
  
    const handleSubmit = async (data: ${pascalName}Payload) => {
      await update${pascalName}({ slug, data });
      onComplete?.();
    };
  
    if (!${camelName}) {
      return null;
    }
  
    return (
      <EntityForm<${pascalName}Payload>
        title="${pascalName}"
        initialData={${camelName}}
        onSubmit={handleSubmit}
        isSubmitting={isUpdating}
        Form={${pascalName}Form}
        queryKey={${camelName}Keys.all}
        mode="edit"
      />
    );
  }`;

  await writeFile(path.join(outputDir, 'components/organisms', 'edit.tsx'), editContent);
};

// Generate Delete Component
const generateDeleteComponent = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  const deleteContent = `'use client';
  
  import { use${pascalName}Mutations } from '../../hooks/use-${formatName(name, 'kebab')}';
  import { EntityDelete } from '@/shared/components/molecules/table/entity-delete';
  import { ${camelName}Keys } from '../../config/${formatName(name, 'kebab')}.key';
  
  interface DeleteProps {
    slug: string;
    onComplete?: () => void;
  }
  
  export function Delete({ slug, onComplete }: DeleteProps) {
    const { delete${pascalName} } = use${pascalName}Mutations();
  
    return (
      <EntityDelete
        entityId={slug}
        entityName="${pascalName}"
        deleteService={async (id: string) => await delete${pascalName}(id)}
        queryKey={${camelName}Keys.all}
        onActionComplete={onComplete}
      />
    );
  }`;

  await writeFile(path.join(outputDir, 'components/organisms', 'delete.tsx'), deleteContent);
};

// Generate Page Component
const generatePageComponent = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const pluralPascal = formatName(formatName(name, 'plural'), 'pascal');
  const camelPlural = formatName(formatName(name, 'plural'), 'camel');

  const pageContent = `'use client';
  
  import { DataTable } from '@/shared/components/molecules/datatable/data-table';
  import { columns } from '@/features/${formatName(name, 'kebab')}/components/organisms/columns';
  import { use${pluralPascal} } from '@/features/${formatName(name, 'kebab')}/hooks/use-${formatName(name, 'kebab')}';
  import { Add } from '@/features/${formatName(name, 'kebab')}/components/organisms/add';
  import { useTableParams } from '@/shared/hooks/use-table-params';
  
  export default function ${pascalName}Page() {
    const { params, tableProps } = useTableParams();
    const { data, meta, isLoading } = use${pluralPascal}(params);
  
    return (
      <div className="space-y-4">
        <div className='flex items-center justify-between'>
          <div className='flex flex-col'>
            <h2 className="text-2xl font-bold tracking-tight">Manage ${pluralPascal}</h2>
            <p className="text-muted-foreground">
              You can create, edit, and delete ${camelPlural} here.
            </p>
          </div>
          <Add />
        </div>
  
        <DataTable
          columns={columns}
          data={data}
          meta={meta}
          isLoading={isLoading}
          isError={false}
          {...tableProps}
        />
      </div>
    );
  }`;

  await writeFile(path.join(outputDir, 'pages', `page.tsx`), pageContent);
};

// Generate API Routes
const generateApiRoutes = async (name, outputDir) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');
  const camelPlural = formatName(formatName(name, 'plural'), 'camel');

  // Create API directories
  const apiBaseDir = path.join(process.cwd(), 'app/api/v1', camelPlural);
  const apiSlugDir = path.join(apiBaseDir, '[slug]');

  await ensureDirectoryExists(apiBaseDir);
  await ensureDirectoryExists(apiSlugDir);

  // Generate index route
  const indexRouteContent = `import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { createSearchParams } from '@/shared/domain/base.search-param';
import { create${pascalName}, get${formatName(formatName(name, 'plural'), 'pascal')} } from '@/features/${formatName(name, 'kebab')}/domain/use-cases';

export async function GET(request: NextRequest) {
   const searchParams = createSearchParams();
   const filter = searchParams.load(request);
  const data = await get${formatName(formatName(name, 'plural'), 'pascal')}(filter);

  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const data = await create${pascalName}(body);

  return NextResponse.json(data);
}`;

  await writeFile(path.join(apiBaseDir, 'route.ts'), indexRouteContent);

  // Generate slug route
  const slugRouteContent = `import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { delete${pascalName}, get${pascalName}, update${pascalName} } from '@/features/${formatName(name, 'kebab')}/domain/use-cases';

export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const slug = params.slug;
  const data = await get${pascalName}(slug);

  return NextResponse.json(data);
}

export async function PUT(request: NextRequest, { params }: { params: { slug: string } }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const slug = params.slug;
  const body = await request.json();
  await update${pascalName}(slug, body);

  return NextResponse.json({ message: '${pascalName} updated successfully' });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const slug = params.slug;
  await delete${pascalName}(slug);

  return NextResponse.json({ message: '${pascalName} deleted successfully' });
}`;

  await writeFile(path.join(apiSlugDir, 'route.ts'), slugRouteContent);

  console.log(chalk.green(`✅ API routes generated in app/api/v1/${camelPlural}`));
};

// Update API Endpoints
const updateApiEndpoints = async (name, apiConfigPath) => {
  const pascalName = formatName(name, 'pascal');
  const camelPlural = formatName(formatName(name, 'plural'), 'camel');

  try {
    let apiConfigContent = await readFile(apiConfigPath, 'utf8');

    // Trouver l'objet API_ENDPOINTS avec une regex plus flexible
    const endpointsRegex = /export\s+const\s+API_ENDPOINTS\s*=\s*\{([\s\S]*?)\}\s*as\s*const\s*;/;
    const match = apiConfigContent.match(endpointsRegex);

    if (match) {
      const existingEndpoints = match[1];

      // Vérifier si l'endpoint existe déjà
      if (!existingEndpoints.includes(`,${camelPlural}: {`)) {
        // Ajouter le nouvel endpoint
        const newEndpoint = `
  ${camelPlural}: {
    base: '/${camelPlural}',
    list: (qs: string) => \`/${camelPlural}\${qs}\`,
    create: '/${camelPlural}',
    detail: (slug: string) => \`/${camelPlural}/\${slug}\`,
    update: (slug: string) => \`/${camelPlural}/\${slug}\`,
    delete: (slug: string) => \`/${camelPlural}/\${slug}\`,
  },`;

        // Insérer le nouvel endpoint avant l'accolade fermante
        const updatedContent = apiConfigContent.replace(
          endpointsRegex,
          `export const API_ENDPOINTS = {${existingEndpoints}${newEndpoint}\n} as const;`
        );

        await writeFile(apiConfigPath, updatedContent);
        console.log(chalk.green(`✅ API endpoints mis à jour avec les routes ${pascalName}`));
      } else {
        console.log(chalk.yellow(`⚠️ Les endpoints ${pascalName} existent déjà, mise à jour ignorée`));
      }
    } else {
      // Approche alternative si la regex ne fonctionne pas
      console.log(chalk.yellow(`⚠️ Structure non reconnue dans le fichier API_ENDPOINTS, tentative d'approche alternative...`));

      // Chercher la dernière accolade avant "as const"
      const lastBraceIndex = apiConfigContent.lastIndexOf('}', apiConfigContent.indexOf('as const'));

      if (lastBraceIndex !== -1) {
        const newEndpoint = `
            ${camelPlural}: {
              base: '/${camelPlural}',
              list: (qs: string) => \`/${camelPlural}\${qs}\`,
              create: '/${camelPlural}',
              detail: (slug: string) => \`/${camelPlural}/\${slug}\`,
              update: (slug: string) => \`/${camelPlural}/\${slug}\`,
              delete: (slug: string) => \`/${camelPlural}/\${slug}\`,
            },`;

        // Insérer avant la dernière accolade
        const updatedContent =
          apiConfigContent.substring(0, lastBraceIndex) +
          newEndpoint +
          apiConfigContent.substring(lastBraceIndex);

        await writeFile(apiConfigPath, updatedContent);
        console.log(chalk.green(`✅ API endpoints mis à jour avec approche alternative`));
      } else {
        console.log(chalk.red('❌ Impossible de trouver la structure API_ENDPOINTS dans le fichier de configuration'));
      }
    }
  } catch (error) {
    console.error(chalk.red(`Erreur lors de la mise à jour des API endpoints: ${error.message}`));
  }
};

// Update navigation sidebar
const updateSidebar = async (name) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');
  const camelPlural = formatName(formatName(name, 'plural'), 'camel');

  try {
    // Path to the navigation constants file
    const navConstantsPath = path.join(process.cwd(), 'shared/lib/constants/app.constant.ts');

    if (fs.existsSync(navConstantsPath)) {
      let navContent = await readFile(navConstantsPath, 'utf8');

      // Check if the feature is already in the navigation
      if (navContent.includes(`title: '${pascalName}'`)) {
        console.log(chalk.yellow(`⚠️ ${pascalName} already exists in navigation, skipping update`));
        return;
      }

      // Find the navItems array
      const navItemsRegex = /export\s+const\s+navItems\s*:\s*NavItem\[\]\s*=\s*\[([\s\S]*?)\];/;
      const match = navContent.match(navItemsRegex);

      if (match) {
        const existingNavItems = match[1];

        // Create a new nav item
        const newNavItem = `,
  {
    title: '${pascalName}',
    url: '/d/master/${formatName(name, 'kebab')}',
    icon: 'post',
    shortcut: ['${camelName[0]}', '${camelName[0]}'],
    isActive: false,
    items: []
  },`;

        // Add the new nav item before the closing bracket
        const updatedContent = navContent.replace(
          navItemsRegex,
          `export const navItems: NavItem[] = [${existingNavItems}${newNavItem}\n];`
        );

        await writeFile(navConstantsPath, updatedContent);
        console.log(chalk.green(`✅ Added ${pascalName} to navigation sidebar`));
      } else {
        console.log(chalk.yellow(`⚠️ Could not find navItems array in ${navConstantsPath}`));
      }
    } else {
      console.log(chalk.yellow(`⚠️ Navigation constants file not found at ${navConstantsPath}`));
    }
  } catch (error) {
    console.error(chalk.red(`Error updating navigation sidebar: ${error.message}`));
  }
};

// Generate page route for the admin panel
const generateAdminPageRoute = async (name) => {
  const pascalName = formatName(name, 'pascal');
  const camelName = formatName(name, 'camel');

  try {
    // Path to create the admin page route
    const adminPageDir = path.join(process.cwd(), 'app/(admin)/d/master', formatName(name, 'kebab'));
    await ensureDirectoryExists(adminPageDir);

    // Generate the page component
    const pageContent = `'use client';

import { DataTable } from '@/shared/components/molecules/datatable/data-table';
import { columns } from '@/features/${formatName(name, 'kebab')}/components/organisms/columns';
import { use${formatName(formatName(name, 'plural'), 'pascal')} } from '@/features/${formatName(name, 'kebab')}/hooks/use-${formatName(name, 'kebab')}';
import { Add } from '@/features/${formatName(name, 'kebab')}/components/organisms/add';
import { useTableParams } from '@/shared/hooks/use-table-params';

export default function ${pascalName}Page() {
  const { params, tableProps } = useTableParams();
  const { data, meta, isLoading } = use${formatName(formatName(name, 'plural'), 'pascal')}(params);

  return (
    <div className="space-y-4">
      <div className='flex items-center justify-between'>
        <div className='flex flex-col'>
          <h2 className="text-2xl font-bold tracking-tight">Manage ${formatName(formatName(name, 'plural'), 'pascal')}</h2>
          <p className="text-muted-foreground">
            You can create, edit, and delete ${formatName(name, 'plural')} here.
          </p>
        </div>
        <Add />
      </div>

      <DataTable
        columns={columns}
        data={data}
        meta={meta}
        isLoading={isLoading}
        isError={false}
        {...tableProps}
      />
    </div>
  );
}`;

    await writeFile(path.join(adminPageDir, 'page.tsx'), pageContent);
    console.log(chalk.green(`✅ Generated admin page route at app/(admin)/d/master/${formatName(name, 'kebab')}/page.tsx`));

  } catch (error) {
    console.error(chalk.red(`Error generating admin page route: ${error.message}`));
  }
};

// Main function to run the generator
const main = async () => {
  try {
    console.log(chalk.cyan('==================================='));
    console.log(chalk.cyan('🚀 CRUD Generator for Next.js with Drizzle'));
    console.log(chalk.cyan('===================================\n'));

    const name = await askQuestion(chalk.yellow('Enter the entity name (singular, PascalCase): '));
    if (!name) {
      console.log(chalk.red('❌ Entity name is required'));
      rl.close();
      return;
    }

    const schemaPath = path.join(process.cwd(), 'drizzle/schema', `${formatName(name, 'kebab')}.ts`);


    const schema = await parseSchema(schemaPath);
    console.log(chalk.green(`✅ Parsed schema for ${schema.tableName}`));

    const featureDir = path.join(process.cwd(), 'features', formatName(name, 'kebab'));

    const dirs = [
      path.join(featureDir, 'config'),
      path.join(featureDir, 'domain'),
      path.join(featureDir, 'domain/use-cases'),
      path.join(featureDir, 'hooks'),
      path.join(featureDir, 'components/molecules'),
      path.join(featureDir, 'components/organisms'),
      path.join(featureDir, 'pages'),
      path.join(featureDir, 'api'),
      path.join(featureDir, 'api/[slug]'),
    ];

    for (const dir of dirs) {
      await ensureDirectoryExists(dir);
    }

    console.log(chalk.green(`✅ Created directory structure`));

    // Generate configuration files
    await generateTypes(name, schema, featureDir);
    await generateSchema(name, schema, featureDir);
    await generateKeys(name, featureDir);
    console.log(chalk.green(`✅ Generated config files`));

    // Generate domain files
    await generateUseCases(name, schema, featureDir);
    await generateService(name, featureDir);
    console.log(chalk.green(`✅ Generated domain files`));

    // Generate hooks
    await generateHooks(name, featureDir);
    console.log(chalk.green(`✅ Generated hooks`));

    // Generate UI components
    await generateFormComponent(name, schema, featureDir);
    await generateRowActions(name, featureDir);
    await generateColumns(name, schema, featureDir);
    await generateAddComponent(name, featureDir);
    await generateEditComponent(name, featureDir);
    await generateDeleteComponent(name, featureDir);
    console.log(chalk.green(`✅ Generated UI components`));

    // Generate page component
    await generatePageComponent(name, featureDir);
    console.log(chalk.green(`✅ Generated page component`));

    // Generate API routes
    await generateApiRoutes(name, featureDir);
    console.log(chalk.green(`✅ Generated API routes`));

    // Générer le routing administratif et mettre à jour la navigation
    await generateAdminPageRoute(name);
    await updateSidebar(name);
    // Update API endpoints
    const apiConfigPath = path.join(process.cwd(), 'shared/lib/config/api.ts');
    if (fs.existsSync(apiConfigPath)) {
      await updateApiEndpoints(name, apiConfigPath);
    } else {
      console.log(chalk.yellow(`⚠️ API config file not found at ${apiConfigPath}, skipping update`));
    }

    console.log(chalk.green('\n✅ CRUD generator completed successfully!'));
    console.log(chalk.cyan(`\nNext steps:`));
    console.log(chalk.white(`1. Run migrations to update your database schema (if needed)`));
    console.log(chalk.white(`2. Add the new feature to your navigation or sidebar`));
    console.log(chalk.white(`3. Add the new page to your routing configuration`));

  } catch (error) {
    console.error(chalk.red(`Error generating CRUD: ${error.message}`));
    if (error.stack) {
      console.error(chalk.gray(error.stack));
    }
  } finally {
    rl.close();
  }
};

main();